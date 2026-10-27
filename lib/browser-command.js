/** Choose a browser opener without passing the URL through a shell. */
export function browserCommand(url, platform = process.platform) {
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return [platform === "darwin" ? "open" : "xdg-open", [url]];
}
