export default {
  testDir: ".",
  testMatch: "*.spec.mjs",
  workers: 1,
  reporter: "line",
  use: {
    browserName: "chromium",
    headless: true,
  },
};
