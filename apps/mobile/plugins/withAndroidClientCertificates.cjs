const { withMainApplication } = require("expo/config-plugins");
const { START_GUARD } = require("./lib/meshStreamGuard.cjs");

const install = "expo.modules.t3clientcertificates.T3CertificateTransport.install(this)";
const reassert = "expo.modules.t3clientcertificates.T3CertificateTransport.reassert()";
const lifecycle = "ApplicationLifecycleDispatcher.onApplicationCreate(this)";

function installCertificateTransport(source) {
  // Anchor to the method body, not a comment or another lifecycle method. Fail closed if
  // a future Expo template runs initialization before super.onCreate(). These hooks must
  // precede every eagerly created Expo fetch / Fresco client.
  const marker = /override fun onCreate\(\)\s*\{\s*super\.onCreate\(\)[ \t]*;?/g;
  const matches = [...source.matchAll(marker)];
  if (matches.length !== 1)
    throw new Error("Cannot install client certificates before React Native startup");
  const match = matches[0];
  let offset = match.index + match[0].length;
  // withMeshStream.cjs puts its stream process guard right after super.onCreate(); the transport
  // goes after it, so the stream process never installs it.
  if (source.slice(offset).trimStart().startsWith(START_GUARD)) {
    offset = source.indexOf(START_GUARD, offset) + START_GUARD.length;
  }
  if (source.includes(install)) {
    if (!source.slice(offset).trimStart().startsWith(install) || source.split(install).length !== 2)
      throw new Error(
        "Client certificate transport must be installed immediately after super.onCreate()",
      );
    return source;
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.slice(0, offset) + `${newline}    ${install}` + source.slice(offset);
}

// Expo's lifecycle listeners may replace React Native's client factory (expo-app-metrics does), so
// the transport takes it back once they have all run.
function reassertCertificateTransport(source) {
  if (source.split(lifecycle).length !== 2)
    throw new Error("Cannot reassert client certificates after Expo lifecycle start-up");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hooked = `${lifecycle}${newline}    ${reassert}`;
  if (source.includes(reassert)) {
    if (!source.includes(hooked) || source.split(reassert).length !== 2)
      throw new Error("Client certificate transport must be reasserted right after Expo start-up");
    return source;
  }
  return source.replace(lifecycle, hooked);
}

module.exports = (config) =>
  withMainApplication(config, (next) => {
    if (next.modResults.language !== "kt")
      throw new Error("Client certificate startup requires Kotlin MainApplication");
    next.modResults.contents = reassertCertificateTransport(
      installCertificateTransport(next.modResults.contents),
    );
    return next;
  });
module.exports.installCertificateTransport = installCertificateTransport;
module.exports.reassertCertificateTransport = reassertCertificateTransport;
