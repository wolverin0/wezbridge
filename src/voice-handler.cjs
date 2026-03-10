/**
 * Voice-to-text handler using OpenAI Whisper API.
 * Transcribes Telegram voice messages (.ogg) to text prompts.
 *
 * Requires: OPENAI_API_KEY env var
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TEMP_DIR = path.join(os.tmpdir(), 'wezbridge-voice');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Download a file from URL to local temp path.
 * @param {string} url
 * @param {string} filename
 * @returns {Promise<string>} local file path
 */
function downloadFile(url, filename) {
  const localPath = path.join(TEMP_DIR, filename);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    const proto = url.startsWith('https') ? https : require('http');
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        return downloadFile(res.headers.location, filename).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(localPath); });
    }).on('error', (err) => {
      fs.unlink(localPath, () => {});
      reject(err);
    });
  });
}

/**
 * Transcribe an audio file using OpenAI Whisper API.
 * @param {string} filePath - Path to .ogg/.oga file
 * @returns {Promise<string>} transcribed text
 */
async function transcribe(filePath) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — voice transcription unavailable');
  }

  // Use multipart/form-data upload to OpenAI
  const FormData = (() => {
    try { return require('form-data'); } catch {
      // Inline minimal multipart builder if form-data not installed
      return null;
    }
  })();

  if (FormData) {
    return transcribeWithFormData(filePath, FormData);
  }
  return transcribeWithFetch(filePath);
}

async function transcribeWithFormData(filePath, FormDataClass) {
  const form = new FormDataClass();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-1');
  form.append('language', 'es'); // Default to Spanish (Argentina user)

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.text || '');
        } catch (e) {
          reject(new Error(`Whisper API response parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

async function transcribeWithFetch(filePath) {
  // Fallback: use Node 18+ native fetch with Blob
  const { Blob } = require('buffer');
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: 'audio/ogg' });

  const formData = new (globalThis.FormData || require('undici').FormData)();
  formData.append('file', blob, path.basename(filePath));
  formData.append('model', 'whisper-1');
  formData.append('language', 'es');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result.text || '';
}

/**
 * Clean up old temp files (>1 hour old).
 */
function cleanupTemp() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const oneHourAgo = Date.now() - 3600000;
    for (const f of files) {
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < oneHourAgo) fs.unlinkSync(fp);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// Cleanup every 30 minutes
setInterval(cleanupTemp, 1800000);

module.exports = {
  downloadFile,
  transcribe,
  cleanupTemp,
  isAvailable: () => !!OPENAI_API_KEY,
  TEMP_DIR,
};
