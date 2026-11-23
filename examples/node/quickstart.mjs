import { launch } from "ant0-browser";

const browser = await launch({ identity: { mode: "native" } });
try {
  const page = await browser.newPage();
  await page.goto("https://example.com");
  console.log(await page.title());
} finally {
  await browser.close();
}
