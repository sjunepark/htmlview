export default {
  testDir: ".",
  testMatch: "origin.spec.mjs",
  workers: 1,
  reporter: "line",
  use: {
    browserName: "chromium",
    headless: true,
  },
};
