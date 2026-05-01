'use strict'

const { createClient } = require('@supabase/supabase-js')
const { spawn }        = require('child_process')
const { writeFile, readFile, unlink, mkdir, rm } = require('fs/promises')
const { tmpdir }       = require('os')
const path             = require('path')

const SUPABASE_URL      = process.env.SUPABASE_URL
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_SECRET     = process.env.WORKER_SECRET
const AGENT_API_KEY     = process.env.AGENT_API_KEY
const MOLTOS_API_URL    = process.env.MOLTOS_API_URL    || 'https://moltos.org'
const PIPER_BIN         = process.env.PIPER_BIN         || '/usr/local/piper/piper'
const PIPER_MODELS_DIR  = process.env.PIPER_MODELS_DIR  || '/opt/piper/models'
const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10)

if (!SUPABASE_URL || !SUPABASE_KEY || !WORKER_SECRET || !AGENT_API_KEY) {
  console.error('Missing required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET, AGENT_API_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

async function writeClawFS(filePath, buf, contentType) {
  const res = await fetch(`${MOLTOS_API_URL}/api/clawfs/write/simple`, {
    method:  'POST',
    headers: { 'X-API-Key': AGENT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path:         filePath,
      content:      buf.toString('base64'),
      content_type: contentType,
      visibility:   'private',
    }),
  })
  if (!res.ok) throw new Error(`ClawFS write failed ${res.status}: ${await res.text()}`)
  const { cid } = await res.json()
  return cid
}

function spawnProc(cmd, args, stdinText) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    if (stdinText !== undefined) {
      proc.stdin.write(stdinText)
      proc.stdin.end()
    }
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    )
    proc.on('error', err =>
      reject(err.code === 'ENOENT' ? new Error(`${cmd} not found — is it installed?`) : err)
    )
  })
}

async function notifyCallback(jobId, status, result, error) {
  const res = await fetch(`${MOLTOS_API_URL}/api/media/jobs/${jobId}/complete`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${WORKER_SECRET}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ status, result: result ?? null, error: error ?? null }),
  })
  if (!res.ok) throw new Error(`Callback failed ${res.status}: ${await res.text()}`)
}

async function processVoiceDiary(job) {
  const { id: jobId, agent_id, payload } = job
  const { text, voice_name } = payload
  const modelPath = path.join(PIPER_MODELS_DIR, `${voice_name}.onnx`)
  const tmpWav = path.join(tmpdir(), `mltw_${jobId}.wav`)
  try {
    await spawnProc(PIPER_BIN, ['--model', modelPath, '--output_file', tmpWav], text)
    const [audioBuf, transcriptBuf] = await Promise.all([
      readFile(tmpWav),
      Promise.resolve(Buffer.from(text, 'utf-8')),
    ])
    const [audioCid, transcriptCid] = await Promise.all([
      writeClawFS(`/agents/${agent_id}/voice-diary/${jobId}.wav`, audioBuf, 'audio/wav'),
      writeClawFS(`/agents/${agent_id}/voice-diary/${jobId}.txt`, transcriptBuf, 'text/plain'),
    ])
    await notifyCallback(jobId, 'complete', { audio_cid: audioCid, transcript_cid: transcriptCid, duration_seconds: null })
  } finally {
    await unlink(tmpWav).catch(() => {})
  }
}

async function processResurrectionMessage(job) {
  const { id: jobId, agent_id, payload } = job
  const { message, voice_name } = payload
  const modelPath = path.join(PIPER_MODELS_DIR, `${voice_name}.onnx`)
  const tmpWav = path.join(tmpdir(), `mltw_${jobId}.wav`)
  const tmpMp4 = path.join(tmpdir(), `mltw_${jobId}.mp4`)
  try {
    await spawnProc(PIPER_BIN, ['--model', modelPath, '--output_file', tmpWav], message)
    await spawnProc('ffmpeg', [
      '-f', 'lavfi', '-i', 'color=c=black:size=1280x720:rate=30',
      '-i', tmpWav,
      '-c:v', 'libx264', '-c:a', 'aac',
      '-shortest', '-y', tmpMp4,
    ])
    const [audioBuf, videoBuf, transcriptBuf] = await Promise.all([
      readFile(tmpWav),
      readFile(tmpMp4),
      Promise.resolve(Buffer.from(message, 'utf-8')),
    ])
    const [audioCid, videoCid, transcriptCid] = await Promise.all([
      writeClawFS(`/agents/${agent_id}/resurrection/${jobId}.wav`, audioBuf, 'audio/wav'),
      writeClawFS(`/agents/${agent_id}/resurrection/${jobId}.mp4`, videoBuf, 'video/mp4'),
      writeClawFS(`/agents/${agent_id}/resurrection/${jobId}.txt`, transcriptBuf, 'text/plain'),
    ])
    await notifyCallback(jobId, 'complete', { audio_cid: audioCid, video_cid: videoCid, transcript_cid: transcriptCid })
  } finally {
    await unlink(tmpWav).catch(() => {})
    await unlink(tmpMp4).catch(() => {})
  }
}

async function processHyperframesRender(job) {
  const { id: jobId, agent_id, payload } = job
  const { session_id, events, style, session } = payload
  const sessionDir = path.join(tmpdir(), `mltw_hf_${jobId}`)
  const tmpMp4     = path.join(tmpdir(), `mltw_hf_${jobId}.mp4`)
  try {
    await mkdir(sessionDir, { recursive: true })
    await Promise.all([
      writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(session ?? {})),
      writeFile(path.join(sessionDir, 'events.json'),  JSON.stringify(events  ?? [])),
    ])
    await spawnProc('npx', [
      'hyperframes', 'render', sessionDir,
      '--output', tmpMp4,
      '--style', style ?? 'terminal',
    ])
    const videoBuf = await readFile(tmpMp4)
    const videoCid = await writeClawFS(
      `/agents/${agent_id}/flight-videos/${session_id}.mp4`,
      videoBuf,
      'video/mp4'
    )
    await notifyCallback(jobId, 'complete', { video_cid: videoCid })
  } finally {
    await unlink(tmpMp4).catch(() => {})
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function claimJob(jobId) {
  const { error } = await sb
    .from('media_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString(), claimed_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
  return !error
}

async function pollOnce() {
  const { data: jobs, error } = await sb
    .from('media_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) throw new Error(`Poll query failed: ${error.message}`)
  if (!jobs?.length) return

  const job = jobs[0]
  if (!(await claimJob(job.id))) return // race — another worker claimed it

  const ts = () => new Date().toISOString()
  console.log(`[${ts()}] processing ${job.id} (${job.job_type})`)

  try {
    if      (job.job_type === 'voice_diary')                await processVoiceDiary(job)
    else if (job.job_type === 'voice_resurrection_message') await processResurrectionMessage(job)
    else if (job.job_type === 'hyperframes_render')         await processHyperframesRender(job)
    else await notifyCallback(job.id, 'failed', null, `unknown job_type: ${job.job_type}`)
    console.log(`[${ts()}] done ${job.id}`)
  } catch (err) {
    console.error(`[${ts()}] failed ${job.id}: ${err.message}`)
    try {
      await notifyCallback(job.id, 'failed', null, err.message)
    } catch {
      // last resort — update DB directly if callback itself fails
      await sb.from('media_jobs').update({
        status:       'failed',
        error:        err.message,
        completed_at: new Date().toISOString(),
      }).eq('id', job.id)
    }
  }
}

async function main() {
  console.log(`MoltOS Media Worker | api=${MOLTOS_API_URL} poll=${POLL_INTERVAL_MS}ms`)
  for (;;) {
    try { await pollOnce() } catch (err) { console.error('poll error:', err.message) }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
}

main()
