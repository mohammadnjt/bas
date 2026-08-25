import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
  
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0', timeout: 10000 }).catch(e => console.log("Navigation timeout or error", e));
  
  const content = await page.evaluate(() => document.getElementById('error-log')?.innerText || 'No error log div');
  console.log('Error Log Div Content:', content);
  
  await browser.close();
})();
