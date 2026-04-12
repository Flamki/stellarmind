import puppeteer from 'puppeteer';
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder';

const delay = ms => new Promise(res => setTimeout(res, ms));

async function main() {
  console.log('Starting browser...');
  const browser = await puppeteer.launch({ 
    headless: false, // show the browser window so user knows it's happening
    defaultViewport: { width: 1536, height: 750 },
    args: ['--window-size=1536,830']
  });

  const page = await browser.newPage();
  
  const Config = {
    followNewTab: true,
    fps: 25,
    ffmpeg_Path: null,
    videoFrame: { width: 1536, height: 750 },
    videoCrf: 18,
    videoCodec: 'libx264',
    videoPreset: 'ultrafast',
    videoBitrate: 1000,
    autopad: { color: 'black' },
    recordDurationLimit: 120, // 2 minutes max
  };

  const recorder = new PuppeteerScreenRecorder(page, Config);

  console.log('Recording started...');
  await recorder.start('./stellar_winning_demo_x402.mp4');

  try {
    console.log('Navigating to dashboard...');
    await page.goto('http://localhost:3001', { waitUntil: 'domcontentloaded' });
    await delay(4000);

    // Agent Registry
    console.log('Viewing Agent Registry...');
    await page.waitForSelector('.sidebar-item');
    await page.evaluate(() => {
      document.querySelectorAll('.sidebar-item')[1].click();
    });
    await delay(4000);

    // API Status
    console.log('Viewing API Status...');
    await page.evaluate(() => {
      document.querySelectorAll('.sidebar-item')[2].click();
    });
    await delay(2000);
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await delay(4000);

    // Orchestrator
    console.log('Starting Orchestrator Task...');
    await page.evaluate(() => {
      document.querySelectorAll('.sidebar-item')[0].click();
    });
    await delay(2000);

    await page.focus('#task-input');
    await page.type('#task-input', 'Research AI agent micropayments on Stellar', { delay: 60 });
    await delay(1000);

    await page.click('#btn-run');
    
    // Wait for the AI and payments to finish
    console.log('Waiting 55 seconds for agents to execute via x402...');
    for(let i = 0; i < 11; i++) {
        await delay(5000);
        process.stdout.write('.');
    }
    console.log('\nExecution complete.');

    // Reveal Task Results
    await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
    await delay(6000);

    // Transactions page
    console.log('Viewing Transactions tab...');
    await page.evaluate(() => {
      document.querySelectorAll('.sidebar-item')[3].click();
    });
    await delay(4000);
    
    console.log('Done recording.');
  } catch (err) {
    console.error('Error during automation:', err);
  }

  await recorder.stop();
  await browser.close();
  console.log('Saved to stellar_winning_demo_x402.mp4');
}

main();
