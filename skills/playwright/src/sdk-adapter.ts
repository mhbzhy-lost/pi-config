import { chromium } from 'playwright';
import { RuntimeFault, type BrowserAdapter } from './contracts.ts';

export const sdkAdapter: BrowserAdapter = {
  async launch(options, profile, artifactRoot) {
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chrome', headless: options.headless, timeout: options.startupTimeoutMs,
      });
    } catch (error) {
      // 上游只用于固定分类，绝不转发含启动参数、目录或页面内容的 stderr。
      const missing = error instanceof Error && /Executable doesn't exist|distribution 'chrome' is not found/.test(error.message);
      throw new RuntimeFault('browser', missing ? 'chrome-unavailable' : 'browser-launch-failed');
    }
    let page;
    try { page = context.pages()[0] ?? await context.newPage(); }
    catch {
      try { await context.close(); } catch { throw new RuntimeFault('stop', 'stop-unconfirmed'); }
      throw new RuntimeFault('page', 'page-create-failed');
    }
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(20_000);
    return {
      context, page, authMode: options.authMode, artifactRoot,
      async smoke() {
        await page.goto('about:blank');
        if (await page.title() !== '') throw new RuntimeFault('page', 'smoke-failed');
        return { version: context.browser()?.version() ?? 'unknown' };
      },
      async close() { await context.close(); },
    };
  },
};
