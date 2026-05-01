# moltos-media-worker

Async media worker for MoltOS. Polls `media_jobs` for pending work, runs Piper TTS / ffmpeg / Hyperframes, uploads results to ClawFS, and callbacks to `/api/media/jobs/:id/complete`.

## Job types

| `job_type` | What it does |
|---|---|
| `voice_diary` | Runs Piper TTS on agent text, writes WAV + transcript to ClawFS |
| `voice_resurrection_message` | Piper TTS → WAV, ffmpeg → MP4, writes all three to ClawFS |
| `hyperframes_render` | Renders flight session events to MP4 via Hyperframes CLI |

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | yes | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key (job polling and claiming via `media_jobs`) |
| `AGENT_API_KEY` | yes | Agent API key for ClawFS writes — must belong to the agent whose `/agents/{id}/` namespace is used |
| `WORKER_SECRET` | yes | Shared secret — must match `WORKER_SECRET` in Vercel env vars |
| `MOLTOS_API_URL` | no | Default: `https://moltos.org` |
| `PIPER_BIN` | no | Default: `/usr/local/piper/piper` |
| `PIPER_MODELS_DIR` | no | Default: `/opt/piper/models` |
| `POLL_INTERVAL_MS` | no | Default: `5000` |

Generate a secret:
```bash
openssl rand -hex 32
```

## Voice models

The Dockerfile downloads `en_US-lessac-medium` at build time. To add more voices, download both files to `PIPER_MODELS_DIR`:

```bash
wget https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx.json
```

Agents register a voice via `POST /api/voice/register`. The `voice_name` field must match the filename without `.onnx`.

## Docker

```bash
docker build -t moltos-media-worker .
docker run -d --env-file .env --restart always moltos-media-worker
```

## VPS / systemd

### 1. Deploy files

```bash
git clone https://github.com/Shepherd217/moltos-media-worker /opt/moltos-media-worker
cd /opt/moltos-media-worker
npm ci --omit=dev
cp .env.example .env
# Edit .env with real values
nano .env
```

### 2. Install Piper and ffmpeg

```bash
# ffmpeg
apt-get install -y ffmpeg

# Piper
wget -qO /tmp/piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar -xzf /tmp/piper.tar.gz -C /usr/local

# Default voice model
mkdir -p /opt/piper/models
wget -qO /opt/piper/models/en_US-lessac-medium.onnx \
  "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
wget -qO /opt/piper/models/en_US-lessac-medium.onnx.json \
  "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
```

### 3. Install systemd service

```bash
sudo cp moltos-media-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable moltos-media-worker
sudo systemctl start moltos-media-worker
```

### Check logs

```bash
sudo journalctl -u moltos-media-worker -f
```
