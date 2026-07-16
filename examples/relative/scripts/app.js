const response = await fetch("./data/message.json", { cache: "no-store" });
const payload = await response.json();

document.querySelector("#message").textContent = payload.message;
document.querySelector("#module-status").textContent = "loaded";
document.querySelector("#origin").textContent = window.location.origin;
