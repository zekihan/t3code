// MainApplication also runs in the `:stream` process (see withMeshStream.cjs). These are the
// statements that keep React Native, Expo and the certificate transport from starting there.
// withAndroidClientCertificates.cjs reads START_GUARD to place its install after it.
const STREAM_PROCESS = "expo.modules.t3clientcertificates.stream.StreamProcess";

module.exports = {
  START_GUARD: `if (${STREAM_PROCESS}.onApplicationCreate(this)) return`,
  CONFIGURATION_GUARD: `if (${STREAM_PROCESS}.isStreamProcess(this)) return`,
};
