import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const recordingsDir = path.join(repoRoot, 'recordings');

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

function runCommandCapture(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
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

async function readLatestPath(markerFile, label) {
  const markerPath = path.join(recordingsDir, markerFile);
  const value = (await fs.readFile(markerPath, 'utf8')).trim();
  if (!value) throw new Error(`${label} marker is empty: ${markerPath}`);
  return value;
}

async function probeDurationSeconds(filePath, label) {
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
    `Probe ${label} duration`,
  );
  const value = Number.parseFloat(out);
  if (!Number.isFinite(value)) {
    throw new Error(`Unable to parse duration for ${label}: ${filePath}`);
  }
  return value;
}

async function main() {
  await fs.mkdir(recordingsDir, { recursive: true });

  console.log('\nStep 1/3: Record website-only demo video.\n');
  await runCommand('node', ['src/record-demo-video.js'], 'Video recording');
  const videoPath = await readLatestPath('latest-video.txt', 'Video');

  console.log('\nStep 2/3: Generate smooth voiceover track.\n');
  await runCommand('node', ['src/generate-demo-voiceover.js'], 'Voiceover');
  const audioPath = await readLatestPath('latest-audio.txt', 'Audio');

  console.log('\nStep 3/3: Mux narration + website capture.\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(recordingsDir, `stellar-demo-narrated-${stamp}.mp4`);
  const videoDuration = await probeDurationSeconds(videoPath, 'video');
  const audioDuration = await probeDurationSeconds(audioPath, 'audio');
  const delta = audioDuration - videoDuration;

  let filterComplex = '';
  let outputDuration = 0;

  if (delta > 0.05) {
    // Keep narration natural; extend video tail instead of trimming audio.
    const holdSeconds = (delta + 0.25).toFixed(3);
    filterComplex = `[0:v]tpad=stop_mode=clone:stop_duration=${holdSeconds}[v];[1:a]anull[a]`;
    outputDuration = audioDuration + 0.1;
    console.log(`Audio is longer by ${delta.toFixed(2)}s, extending final video tail.`);
  } else if (delta < -0.05) {
    const padSeconds = ((-delta) + 0.1).toFixed(3);
    filterComplex = `[0:v]null[v];[1:a]apad=pad_dur=${padSeconds}[a]`;
    outputDuration = videoDuration + 0.1;
    console.log(`Video is longer by ${(-delta).toFixed(2)}s, padding narration tail.`);
  } else {
    filterComplex = '[0:v]null[v];[1:a]anull[a]';
    outputDuration = Math.max(videoDuration, audioDuration) + 0.1;
    console.log('Audio and video are already closely aligned.');
  }

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-filter_complex',
      filterComplex,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-t',
      `${outputDuration.toFixed(3)}`,
      outputPath,
    ],
    'Muxing final video',
  );

  await fs.writeFile(path.join(recordingsDir, 'latest-narrated.txt'), `${outputPath}\n`, 'utf8');
  console.log(`\nNarrated demo created: ${outputPath}\n`);
}

main().catch((err) => {
  console.error(`\nNarrated render failed: ${err.message}\n`);
  process.exit(1);
});
