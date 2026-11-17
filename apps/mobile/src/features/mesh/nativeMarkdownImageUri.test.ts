import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ selected: vi.fn(), load: vi.fn() }));
vi.mock("../../lib/clientCertificates", () => ({ selectedClientCertificate: mocks.selected }));
vi.mock("../../lib/certificateMedia", () => ({
  loadCertificateMedia: mocks.load,
  certificateMediaExtension: (_uri: string, fallback = "") => fallback,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

it("leaves an unprotected image URL for the native downloader", async () => {
  mocks.selected.mockReturnValue(null);
  const { nativeMarkdownImageUri } = await import("./nativeMarkdownImageUri");
  await expect(nativeMarkdownImageUri("https://cdn.example/a.png")).resolves.toBe(
    "https://cdn.example/a.png",
  );
  expect(mocks.load).not.toHaveBeenCalled();
});

it("hands the native view a private file instead of an environment URL, once per URL", async () => {
  mocks.selected.mockReturnValue("phone");
  mocks.load.mockResolvedValue({ uri: "file:///cache/img-1", dispose: vi.fn() });
  const { nativeMarkdownImageUri } = await import("./nativeMarkdownImageUri");
  const url = "https://env.example/asset/a.png?sig=1";
  await expect(nativeMarkdownImageUri(url)).resolves.toBe("file:///cache/img-1");
  await expect(nativeMarkdownImageUri(url)).resolves.toBe("file:///cache/img-1");
  expect(mocks.load).toHaveBeenCalledOnce();
});

it("does not hand out the environment URL when the download fails, and retries later", async () => {
  mocks.selected.mockReturnValue("phone");
  mocks.load
    .mockRejectedValueOnce(new Error("HTTP 401"))
    .mockResolvedValueOnce({ uri: "file:///cache/img-2", dispose: vi.fn() });
  const { nativeMarkdownImageUri } = await import("./nativeMarkdownImageUri");
  await expect(nativeMarkdownImageUri("https://env.example/a.png")).rejects.toThrow("401");
  await expect(nativeMarkdownImageUri("https://env.example/a.png")).resolves.toBe(
    "file:///cache/img-2",
  );
});

it("deletes the oldest files beyond the cap", async () => {
  mocks.selected.mockReturnValue("phone");
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  mocks.load.mockImplementation(async () => {
    const dispose = vi.fn();
    disposers.push(dispose);
    return { uri: `file:///cache/${disposers.length}`, dispose };
  });
  const { nativeMarkdownImageUri } = await import("./nativeMarkdownImageUri");
  for (let index = 0; index < 34; index++)
    await nativeMarkdownImageUri(`https://env.example/${index}.png`);
  await Promise.resolve();
  expect(disposers[0]).toHaveBeenCalledOnce();
  expect(disposers[1]).toHaveBeenCalledOnce();
  expect(disposers[2]).not.toHaveBeenCalled();
});
