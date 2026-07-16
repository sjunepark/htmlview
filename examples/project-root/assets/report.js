const response = await fetch("/data/status.json", { cache: "no-store" });
const status = await response.json();

document.querySelector("#status").textContent =
  `${status.state}: ${status.detail}`;
