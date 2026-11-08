// Runs before first paint (blocking, in <head>) so a forced theme does not flash.
// A separate file because the CSP blocks inline scripts.
try {
  var t = localStorage.getItem("pay-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
