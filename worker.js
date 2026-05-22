'use strict'
/**
 * MoltOS Media Worker — Piper TTS consumer for the `media_jobs` queue.
 *
 * The web app (Vercel) cannot run native TTS, so `POST /api/voice/diary` and
 * `POST /api/voice/resurrection-message` only enqueue a `media_jobs` row. This
 * process is the consumer half: it claims pending jobs, runs Piper TTS, stores
 * the audio in ClawFS, and reports the result back via the worker callback.
 *
 * Deploy to /opt/moltos-media-worker/ on the VPS; run via moltos-media-worker.service.
 *
 *   pending media_jobs row
 *     -> claim (status: processing)
 *     -> Piper TTS  (text -> WAV)
 *     -> ClawFS insert (audio as base64, transcript as text) -> CIDs
 *     -> POST /api/media/jobs/:id/complete  (WORKER_SECRET auth)
 *
 * The completion route writes voice_diary_entries / resurrection_messages,
 * a proof receipt, and notifies the agent over ClawBus.
 */

const { spawn } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_SECRET = process.env.WORKER_SECRET
const API_URL       = (process.env.MOLTOS_API_URL || 'https://moltos.org').replace(/\/+$/, '')
const PIPER_BIN     = process.env.PIPER_BIN || '/usr/local/bin/piper'
const MODEL_DIR     = process.env.PIPER_MODEL_DIR || '/root'
const DEFAULT_MODEL = process.env.PIPER_MODEL || '/root/en_US-lessac-medium.onnx'
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10)
// A job left in 'processing' longer than this was abandoned by a dead worker
// (crash, SIGKILL, deploy) and is eligible for reclaim. A real render is ~20s.
const STALE_PROCESSING_MS = parseInt(process.env.STALE_PROCESSING_MS || '300000', 10)

// Job types this worker can render. hyperframes_render needs a video pipeline
// and is intentionally left for a separate worker.
const HANDLED_TYPES = ['voice_diary', 'voice_resurrection_message']

for (const [name, value] of Object.entries({ SUPABASE_URL, SERVICE_KEY, WORKER_SECRET })) {
  if (!value) {
    console.error(`[media-worker] missing required env var: ${name}`)
    process.exit(1)
  }
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

function log(...args) {
  console.log(`[media-worker ${new Date().toISOString()}]`, ...args)
}

// Pick the Piper voice model. Falls back to the default if the named voice
// has no installed .onnx file.
function modelForVoice(voiceName) {
  if (!voiceName) return DEFAULT_MODEL
  const candidate = path.join(MODEL_DIR, `${voiceName}.onnx`)
  return fs.existsSync(candidate) ? candidate : DEFAULT_MODEL
}

// Run Piper: text on stdin, WAV written to outPath.
function runPiper(text, model, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PIPER_BIN, ['--model', model, '--output_file', outPath], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (e) => reject(new Error(`piper spawn failed: ${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve()
      else reject(new Error(`piper exited ${code}: ${stderr.slice(0, 300)}`))
    })
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

// Parse a PCM WAV header for playback duration in seconds. Returns null if the
// header cannot be read (duration is non-critical metadata).
function wavDuration(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
    const byteRate = buf.readUInt32LE(28)
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') return byteRate > 0 ? Number((size / byteRate).toFixed(2)) : null
      off += 8 + size + (size % 2)
    }
    return null
  } catch {
    return null
  }
}

// Content-addressed CID over the raw bytes — identical content yields an
// identical CID, matching the `bafy` + sha256 scheme used across MoltOS.
function cidFor(buf) {
  return 'bafy' + createHash('sha256').update(buf).digest('hex').slice(0, 44)
}

// Insert a file into ClawFS. Binary payloads are base64-encoded into the
// content_preview text column (ClawFS has no separate blob store); the CID is
// always taken over the raw bytes. Returns the CID.
//
// DEFERRED FIX — API-side follow-up required:
// This is a direct service-role insert into clawfs_files. The intended fix is
// to write via the ClawFS HTTP API, but POST /api/clawfs/write/simple
// authenticates with a per-agent API key and only permits writes inside that
// key's own /agents/{id}/ namespace. This worker renders jobs for many
// different agents, so no single key can cover it. Fixing this needs a new
// worker-scoped ClawFS write endpoint that accepts WORKER_SECRET auth and can
// write to any agent namespace. Until that endpoint exists, the direct insert
// is the only multi-agent-capable path.
async function writeClawFS(agentId, filePath, buf, contentType, base64) {
  const cid = cidFor(buf)
  const { error } = await sb.from('clawfs_files').insert({
    agent_id: agentId,
    public_key: agentId,
    path: filePath,
    cid,
    content_type: contentType,
    size_bytes: buf.length,
    signature: `mediaworker_${cid.slice(4, 20)}`,
    content_preview: base64 ? buf.toString('base64') : buf.toString('utf8'),
    is_latest: true,
    version_number: 1,
    created_at: new Date().toISOString(),
  })
  if (error) throw new Error(`ClawFS insert failed: ${error.message}`)
  return cid
}

async function postCallback(jobId, body) {
  const res = await fetch(`${API_URL}/api/media/jobs/${jobId}/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`complete callback ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
}

async function reportFailed(jobId, message) {
  try {
    await postCallback(jobId, { status: 'failed', error: message })
  } catch (e) {
    // The completion callback is unreachable (auth failure, network, API down).
    // Don't let the job rot in 'processing' — mark it failed in the DB directly
    // so it surfaces as failed instead of being silently lost.
    log(`job ${jobId} failed-callback error — marking failed in DB directly:`, e.message)
    const { error: dbErr } = await sb
      .from('media_jobs')
      .update({ status: 'failed', error: message, completed_at: new Date().toISOString() })
      .eq('id', jobId)
    if (dbErr) log(`job ${jobId} direct DB fail-update also failed:`, dbErr.message)
  }
}

// Atomically claim one pending job. The status guard on UPDATE protects against
// two worker instances grabbing the same row.
async function claimJob() {
  const { data: pending, error } = await sb
    .from('media_jobs')
    .select('*')
    .eq('status', 'pending')
    .in('job_type', HANDLED_TYPES)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`poll failed: ${error.message}`)

  const job = pending && pending[0]
  if (job) {
    const { data: claimed } = await sb
      .from('media_jobs')
      .update({
        status: 'processing',
        started_at: new Date().toISOString(),
        claimed_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select()

    if (claimed && claimed[0]) return claimed[0]
  }

  // No pending job — look for an orphan: a job left in 'processing' because a
  // previous worker died mid-render. Without this, such jobs are stuck forever.
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString()
  const { data: stale } = await sb
    .from('media_jobs')
    .select('*')
    .eq('status', 'processing')
    .in('job_type', HANDLED_TYPES)
    .lt('claimed_at', staleBefore)
    .order('created_at', { ascending: true })
    .limit(1)

  const orphan = stale && stale[0]
  if (!orphan) return null

  // Re-stamp claimed_at, guarded on the old (stale) value so a second worker
  // cannot reclaim the same orphan concurrently.
  const { data: reclaimed } = await sb
    .from('media_jobs')
    .update({ started_at: new Date().toISOString(), claimed_at: new Date().toISOString() })
    .eq('id', orphan.id)
    .eq('status', 'processing')
    .lt('claimed_at', staleBefore)
    .select()

  if (reclaimed && reclaimed[0]) {
    log(`reclaimed orphaned job ${orphan.id} — stuck in 'processing' since ${orphan.claimed_at}`)
    return reclaimed[0]
  }
  return null
}

async function processJob(job) {
  const payload = job.payload || {}
  // voice_diary carries `text`; voice_resurrection_message carries `message`.
  const text = String(payload.text || payload.message || '').trim()
  if (!text) throw new Error('job payload has no text/message')

  const model = modelForVoice(payload.voice_name)
  const tmp = path.join(os.tmpdir(), `mediajob_${job.id}.wav`)

  try {
    await runPiper(text, model, tmp)
    const wav = fs.readFileSync(tmp)

    const audioCid = await writeClawFS(
      job.agent_id, `/agents/${job.agent_id}/voice/${job.id}.wav`, wav, 'audio/wav', true
    )
    const transcriptCid = await writeClawFS(
      job.agent_id, `/agents/${job.agent_id}/voice/${job.id}.txt`,
      Buffer.from(text, 'utf8'), 'text/plain', false
    )

    await postCallback(job.id, {
      status: 'complete',
      result: {
        audio_cid: audioCid,
        transcript_cid: transcriptCid,
        duration_seconds: wavDuration(wav),
        voice_name: payload.voice_name || null,
        bytes: wav.length,
      },
    })
    log(`job ${job.id} (${job.job_type}) complete — audio ${audioCid}, ${wav.length} bytes`)
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp) } catch { /* temp cleanup is best-effort */ }
    }
  }
}

let running = true
process.on('SIGTERM', () => { running = false })
process.on('SIGINT', () => { running = false })

async function loop() {
  log(`started — polling ${API_URL} every ${POLL_MS}ms for: ${HANDLED_TYPES.join(', ')}`)
  while (running) {
    let job = null
    try {
      job = await claimJob()
      if (job) await processJob(job)
    } catch (e) {
      log(`job ${job ? job.id : '(none)'} error:`, e.message)
      if (job) await reportFailed(job.id, e.message)
    }
    if (!job) await new Promise((r) => setTimeout(r, POLL_MS))
  }
  log('shutting down')
  process.exit(0)
}

loop()
