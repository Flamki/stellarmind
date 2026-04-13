import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const recordingsDir = path.join(repoRoot, 'recordings');
const scriptPath = path.join(repoRoot, 'DEMO_VOICEOVER.txt');

dotenv.config({
  path: path.join(repoRoot, '.env'),
  quiet: true,
});

function runCommand(command, args, label, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}: ${stderr.substring(0, 300)}`));
    });
  });
}

function runCommandCapture(command, args, label, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${label} failed with exit code ${code}: ${stderr.substring(0, 300)}`));
    });
  });
}

function cleanupText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .trim();
}

function parseSceneScript(rawText) {
  const lines = rawText.split(/\r?\n/);
  const map = new Map();
  let currentId = null;
  let buffer = [];

  const flush = () => {
    if (!currentId) return;
    const text = cleanupText(buffer.join(' ').trim());
    if (text) map.set(currentId, text);
  };

  for (const line of lines) {
    const marker = line.trim().match(/^\[\[SCENE:([a-z0-9_-]+)\]\]$/i);
    if (marker) {
      flush();
      currentId = marker[1].toLowerCase();
      buffer = [];
      continue;
    }
    if (currentId) buffer.push(line);
  }
  flush();
  return map;
}

async function readTimeline() {
  const pointerPath = path.join(recordingsDir, 'latest-timeline.txt');
  const pointerExists = await fs.stat(pointerPath).then(() => true).catch(() => false);
  if (!pointerExists) {
    throw new Error('Timeline not found. Run `npm run record:video` first.');
  }

  const timelinePath = (await fs.readFile(pointerPath, 'utf8')).trim();
  const payload = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
  const scenes = (payload.scenes || [])
    .filter((scene) => Number.isFinite(scene.durationMs) && scene.durationMs > 0);

  if (scenes.length === 0) {
    throw new Error('Timeline has no usable scenes.');
  }

  return { timelinePath, scenes };
}

async function probeDurationSeconds(filePath) {
  const out = await runCommandCapture(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    `Probe duration ${path.basename(filePath)}`,
  );
  const value = Number.parseFloat(out);
  if (!Number.isFinite(value)) {
    throw new Error(`Unable to parse duration for ${filePath}`);
  }
  return value;
}

async function createSilence(outputPath, durationSeconds) {
  await runCommand(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=24000:cl=mono',
      '-t',
      `${Math.max(0.08, durationSeconds)}`,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '112k',
      outputPath,
    ],
    `Create silence ${path.basename(outputPath)}`,
  );
}

async function synthesizeWithElevenLabs(text, outputPath) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return false;

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: {
      Accept: 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': key,
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: 0.46,
        similarity_boost: 0.9,
        style: 0.28,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs request failed (${response.status}): ${body.substring(0, 300)}`);
  }

  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return true;
}

async function synthesizeWithEdge(text, outputPath) {
  const voice = process.env.DEMO_VOICE || 'en-US-JennyNeural';
  const rate = process.env.DEMO_VOICE_RATE || '+0%';
  const pitch = process.env.DEMO_VOICE_PITCH || '+0Hz';

  await runCommand(
    'python',
    [
      '-m',
      'edge_tts',
      '--text',
      text,
      '--voice',
      voice,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      '--write-media',
      outputPath,
    ],
    `Edge TTS ${path.basename(outputPath)}`,
  );
}

async function padSceneClip(rawClip, sceneClip, targetSeconds) {
  await runCommand(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-i',
      rawClip,
      '-af',
      'apad',
      '-t',
      `${targetSeconds}`,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '112k',
      sceneClip,
    ],
    `Pad scene clip ${path.basename(sceneClip)}`,
  );
}

async function main() {
  await fs.mkdir(recordingsDir, { recursive: true });
  const rawScript = await fs.readFile(scriptPath, 'utf8');
  const scriptByScene = parseSceneScript(rawScript);
  if (scriptByScene.size === 0) {
    throw new Error('DEMO_VOICEOVER.txt must contain [[SCENE:scene_id]] blocks.');
  }

  const { timelinePath, scenes } = await readTimeline();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempDir = path.join(recordingsDir, `voice-scene-build-${stamp}`);
  await fs.mkdir(tempDir, { recursive: true });

  const concatLines = [];
  let engineUsed = process.env.ELEVENLABS_API_KEY ? 'elevenlabs-natural' : 'edge-natural';
  let totalTarget = 0;
  let totalAudio = 0;

  console.log(`\nGenerating narration from timeline:\n${timelinePath}\n`);

  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    const sceneId = scene.id.toLowerCase();
    const sceneText = scriptByScene.get(sceneId);
    const targetSeconds = scene.durationMs / 1000;
    totalTarget += targetSeconds;

    const rawClip = path.join(tempDir, `raw-${String(i).padStart(3, '0')}.mp3`);
    const sceneClip = path.join(tempDir, `scene-${String(i).padStart(3, '0')}.mp3`);

    if (!sceneText) {
      await createSilence(rawClip, targetSeconds);
      await fs.copyFile(rawClip, sceneClip);
      totalAudio += targetSeconds;
      concatLines.push(`file '${path.basename(sceneClip)}'`);
      continue;
    }

    let usedEleven = false;
    if (process.env.ELEVENLABS_API_KEY) {
      usedEleven = await synthesizeWithElevenLabs(sceneText, rawClip);
    }
    if (!usedEleven) {
      await synthesizeWithEdge(sceneText, rawClip);
      if (process.env.ELEVENLABS_API_KEY) engineUsed = 'mixed-natural';
    }

    const naturalDuration = await probeDurationSeconds(rawClip);
    if (naturalDuration <= targetSeconds) {
      await padSceneClip(rawClip, sceneClip, targetSeconds);
      totalAudio += targetSeconds;
    } else {
      // Keep natural speech unchanged; do not cut or speed-change.
      await fs.copyFile(rawClip, sceneClip);
      totalAudio += naturalDuration;
      console.warn(
        `Scene "${sceneId}" narration is longer than scene window by ${(naturalDuration - targetSeconds).toFixed(2)}s (kept natural).`,
      );
    }

    concatLines.push(`file '${path.basename(sceneClip)}'`);
  }

  await fs.writeFile(path.join(tempDir, 'concat.txt'), `${concatLines.join('\n')}\n`, 'utf8');

  const outputPath = path.join(recordingsDir, `stellar-demo-voiceover-${stamp}.mp3`);
  await runCommand(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=9,acompressor=threshold=-18dB:ratio=2.0:attack=20:release=180,highpass=f=70,lowpass=f=10000',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '112k',
      outputPath,
    ],
    'Render final narration',
    tempDir,
  );

  if (process.env.KEEP_VOICE_SEGMENTS !== '1') {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  await fs.writeFile(path.join(recordingsDir, 'latest-audio.txt'), `${outputPath}\n`, 'utf8');
  await fs.writeFile(path.join(recordingsDir, 'latest-audio-engine.txt'), `${engineUsed}\n`, 'utf8');

  console.log(`Target timeline length: ${totalTarget.toFixed(2)}s`);
  console.log(`Narration track length: ${totalAudio.toFixed(2)}s`);
  console.log(`Voiceover created: ${outputPath}\n`);
}

main().catch((err) => {
  console.error(`\nVoiceover generation failed: ${err.message}\n`);
  process.exit(1);
});
