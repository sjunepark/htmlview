export default {
  testDir: ".",
  testMatch: "cli-url.spec.mjs",
  workers: 1,
  reporter: "line",
  use: {
    browserName: "chromium",
    headless: true,
  },
};
