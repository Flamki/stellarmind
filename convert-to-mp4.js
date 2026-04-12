import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const inputWebp = process.argv[2];
const outputMp4 = process.argv[3] || 'stellarmind_demo.mp4';

if (!inputWebp || !fs.existsSync(inputWebp)) {
  console.error('Usage: node convert-to-mp4.js <input.webp> [output.mp4]');
  process.exit(1);
}

const tmpDir = path.join(path.dirname(outputMp4), '_frames_tmp');
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

console.log('Extracting frames from animated WebP...');

// Use webpmux to extract frames, then convert each to PNG
try {
  // First try using ffmpeg with image2 demuxer workaround
  // Extract using webpinfo/webpmux approach
  const webpData = fs.readFileSync(inputWebp);
  
  // Parse animated WebP manually - find ANMF chunks
  const frames = [];
  let offset = 12; // Skip RIFF header + WEBP
  
  while (offset < webpData.length) {
    const chunkId = webpData.toString('ascii', offset, offset + 4);
    const chunkSize = webpData.readUInt32LE(offset + 4);
    
    if (chunkId === 'ANMF') {
      // ANMF chunk: 16 bytes header, then frame data
      const frameX = webpData.readUInt16LE(offset + 8) * 2;
      const frameY = webpData.readUInt16LE(offset + 11) * 2;
      const frameWidth = (webpData.readUInt16LE(offset + 14) & 0x3FFF) + 1;
      const frameHeight = (webpData.readUInt16LE(offset + 17) & 0x3FFF) + 1;
      const duration = webpData.readUInt16LE(offset + 20) | (webpData[offset + 22] << 16);
      
      // Extract frame webp data (after 24 byte ANMF header)
      const frameDataStart = offset + 8 + 16;
      const frameDataSize = chunkSize - 16;
      
      // Create a standalone WebP from the frame
      const frameWebp = Buffer.alloc(frameDataSize + 12);
      frameWebp.write('RIFF', 0);
      frameWebp.writeUInt32LE(frameDataSize + 4, 4);
      frameWebp.write('WEBP', 8);
      webpData.copy(frameWebp, 12, frameDataStart, frameDataStart + frameDataSize);
      
      frames.push({ data: frameWebp, duration, width: frameWidth, height: frameHeight });
    }
    
    offset += 8 + chunkSize + (chunkSize % 2); // pad to even
  }
  
  console.log(`Found ${frames.length} frames`);
  
  if (frames.length === 0) {
    console.error('No frames found. Trying alternative method...');
    // Try using dwebp if available
    execSync(`dwebp "${inputWebp}" -o "${path.join(tmpDir, 'frame_0000.png')}"`, { stdio: 'pipe' });
    frames.push({ duration: 1000 });
  }
  
  // Write each frame as individual WebP then convert to PNG via ffmpeg
  for (let i = 0; i < frames.length; i++) {
    const framePath = path.join(tmpDir, `frame_${String(i).padStart(5, '0')}.webp`);
    const pngPath = path.join(tmpDir, `frame_${String(i).padStart(5, '0')}.png`);
    fs.writeFileSync(framePath, frames[i].data);
    
    try {
      execSync(`ffmpeg -y -i "${framePath}" "${pngPath}" 2>&1`, { stdio: 'pipe' });
    } catch {
      // If single frame conversion fails, skip it
      console.log(`  Skipping frame ${i} (decode error)`);
      // Copy previous frame if available
      if (i > 0) {
        const prevPng = path.join(tmpDir, `frame_${String(i-1).padStart(5, '0')}.png`);
        if (fs.existsSync(prevPng)) fs.copyFileSync(prevPng, pngPath);
      }
    }
    
    if (i % 50 === 0) process.stdout.write(`  Frame ${i}/${frames.length}\r`);
  }
  
  console.log(`\nConverting ${frames.length} frames to MP4...`);
  
  // Calculate average FPS from frame durations
  const avgDuration = frames.reduce((s, f) => s + (f.duration || 100), 0) / frames.length;
  const fps = Math.round(1000 / avgDuration);
  console.log(`  Average frame duration: ${avgDuration}ms, FPS: ${fps}`);
  
  // Stitch PNGs into MP4
  execSync(
    `ffmpeg -y -framerate ${fps} -i "${path.join(tmpDir, 'frame_%05d.png')}" -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart "${outputMp4}"`,
    { stdio: 'inherit' }
  );
  
  console.log(`\n✅ Video saved to: ${outputMp4}`);
  console.log(`   Size: ${(fs.statSync(outputMp4).size / 1024 / 1024).toFixed(1)} MB`);
  
} catch (err) {
  console.error('Conversion error:', err.message);
} finally {
  // Cleanup
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
    console.log('   Cleaned up temp frames');
  }
}
