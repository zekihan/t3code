import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: {
    accessibilityLabel: string;
    value: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      disabled={props.editable === false}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <i>spinner</i>,
}));
vi.mock("../../components/ui/Notice", () => ({
  Notice: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));
vi.mock("../../components/ui/Dialog", () => dialog);
vi.mock("../../components/ui/Button", () => ({
  Button: (props: {
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.label}
      disabled={props.disabled || props.loading}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: {
    title: string;
    detail: string;
    actionLabel?: string;
    onAction?: () => void;
  }) => (
    <section>
      <h1>{props.title}</h1>
      <p>{props.detail}</p>
      {props.actionLabel ? <button onClick={props.onAction}>{props.actionLabel}</button> : null}
    </section>
  ),
}));

import { MeshEnrollmentView, enrollmentViewKind } from "./MeshEnrollmentView";
import type { EnrollmentStatus } from "./meshEnrollment.types";
import type { MeshEnrollmentState } from "./useMeshEnrollment";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const status = (overrides: Partial<EnrollmentStatus> = {}): EnrollmentStatus => ({
  identity: "device-z-phone-mesh",
  issuedAt: NOW - DAY,
  notAfter: NOW + 365 * DAY,
  renewAt: NOW + 275 * DAY,
  state: "valid",
  renewalDue: false,
  protection: "tee",
  exportable: false,
  previous: null,
  caRevision: "rev-1",
  lastCheckAt: NOW,
  lastError: null,
  ...overrides,
});
const state = (overrides: Partial<MeshEnrollmentState> = {}): MeshEnrollmentState => ({
  available: true,
  loaded: true,
  status: null,
  busy: null,
  failure: null,
  notice: null,
  now: NOW,
  ...overrides,
});

function render(
  overrides: Partial<MeshEnrollmentState> = {},
  props: Partial<Parameters<typeof MeshEnrollmentView>[0]> = {},
) {
  const handlers = {
    onEnroll: vi.fn(async () => true),
    onRenew: vi.fn(),
    onRemove: vi.fn(),
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const draw = (next: Partial<MeshEnrollmentState>) =>
    act(() => root.render(<MeshEnrollmentView state={state(next)} {...handlers} {...props} />));
  draw(overrides);
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  const input = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const type = (label: string, value: string) =>
    act(() => {
      const element = input(label);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return {
    container,
    handlers,
    button,
    input,
    type,
    draw,
    unmount: () => act(() => root.unmount()),
  };
}

beforeEach(() => vi.clearAllMocks());

it("picks the view for each state", () => {
  expect(enrollmentViewKind(state({ available: false }), false)).toBe("unavailable");
  expect(enrollmentViewKind(state({ loaded: false }), false)).toBe("loading");
  expect(enrollmentViewKind(state(), false)).toBe("intro");
  expect(enrollmentViewKind(state(), true)).toBe("form");
  expect(enrollmentViewKind(state({ status: status() }), false)).toBe("status");
  expect(enrollmentViewKind(state({ status: status() }), true)).toBe("form");
});

it("says enrollment needs the Android build where the module is missing", () => {
  const { container } = render({ available: false });
  expect(container.textContent).toContain("Enrollment needs the Android app");
});

it("shows a spinner while the native state is read", () => {
  const { container } = render({ loaded: false });
  expect(container.querySelector('[aria-label="Loading enrollment"]')).not.toBeNull();
});

it("invites an unenrolled device to enroll", () => {
  const { container } = render();
  expect(container.textContent).toContain("This device is not enrolled");
  expect(container.textContent).toContain("cannot be exported");
  expect(container.querySelector('input[aria-label="Enrollment token"]')).toBeNull();
  act(() => container.querySelector("button")!.click());
  expect(container.querySelector('input[aria-label="Enrollment token"]')).not.toBeNull();
});

it("enrolls with the typed name and token, then closes the form", async () => {
  const { container, handlers, button, input, type, unmount } = render({}, { startWithForm: true });
  expect(input("Identity name").value).toBe("device-z-phone-mesh");
  expect(button("Enroll")!.disabled).toBe(true);
  type("Enrollment token", "  one-time-token  ");
  expect(button("Enroll")!.disabled).toBe(false);
  await act(async () => button("Enroll")!.click());
  expect(handlers.onEnroll).toHaveBeenCalledWith("device-z-phone-mesh", "one-time-token");
  expect(container.querySelector('input[aria-label="Enrollment token"]')).toBeNull();
  unmount();
});

it("fills either device name from the suggestions", () => {
  const { button, input, unmount } = render({}, { startWithForm: true });
  act(() => button("device-z-tablet-mesh")!.click());
  expect(input("Identity name").value).toBe("device-z-tablet-mesh");
  unmount();
});

it("refuses a name that is not a device identity and says why", () => {
  const { container, button, type, unmount } = render({}, { startWithForm: true });
  type("Enrollment token", "tok");
  type("Identity name", "agent-z-mac");
  expect(container.textContent).toContain("starting with device- and ending with -mesh");
  expect(button("Enroll")!.disabled).toBe(true);
  type("Identity name", "device-z-phone-mesh");
  expect(button("Enroll")!.disabled).toBe(false);
  unmount();
});

it("shows progress while enrolling and locks the form", () => {
  const { container, button, input, unmount } = render({ busy: "enroll" }, { startWithForm: true });
  expect(container.textContent).toContain("Contacting mesh.noqer.com");
  expect(input("Enrollment token").disabled).toBe(true);
  expect(button("Cancel")!.disabled).toBe(true);
  unmount();
});

it("shows the error title and the native message under the form", () => {
  const { container, unmount } = render(
    {
      failure: {
        code: "TOKEN_INVALID",
        title: "Token expired or already used",
        detail: "A token works once and for 15 minutes.",
      },
    },
    { startWithForm: true },
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Token expired or already used. A token works once and for 15 minutes.",
  );
  unmount();
});

it("keeps the form open when enrollment fails", async () => {
  const { container, handlers, button, type, unmount } = render({}, { startWithForm: true });
  handlers.onEnroll.mockResolvedValue(false);
  type("Enrollment token", "tok");
  await act(async () => button("Enroll")!.click());
  expect(container.querySelector('input[aria-label="Enrollment token"]')).not.toBeNull();
  unmount();
});

it("shows the enrolled identity, its expiry and its next renewal", () => {
  const { container } = render({ status: status() });
  const text = container.textContent ?? "";
  expect(text).toContain("Enrolled as device-z-phone-mesh");
  expect(text).toContain("Expires Nov 18, 2027 (365 days left)");
  expect(text).toContain("Renews automatically from Aug 20, 2027.");
  expect(text).toContain("cannot be exported");
  expect(text).toContain("instead of the certificate chosen in KeyChain");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("renews on request, and only while the identity is usable", () => {
  const ready = render({ status: status() });
  act(() => ready.button("Renew now")!.click());
  expect(ready.handlers.onRenew).toHaveBeenCalledOnce();
  const stuck = render({ status: status({ state: "reenroll" }) });
  expect(stuck.button("Renew now")!.disabled).toBe(true);
});

it("asks to re-enroll when the hub refused the leaf", () => {
  const { container, button } = render({ status: status({ state: "reenroll" }) });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Re-enroll this device with a new token",
  );
  act(() => button("Re-enroll")!.click());
  expect(container.textContent).toContain("A new key replaces the current one");
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="Identity name"]')!.value,
  ).toBe("device-z-phone-mesh");
});

it("does not say it twice when a renewal found the leaf refused", () => {
  const { container } = render({
    status: status({ state: "reenroll" }),
    failure: {
      code: "REENROLL_REQUIRED",
      title: "Re-enroll this device",
      detail: "The hub no longer accepts this device's certificate.",
    },
  });
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  const other = render({
    status: status(),
    failure: {
      code: "NETWORK",
      title: "Network problem",
      detail: "Could not reach mesh.noqer.com.",
    },
  });
  expect(other.container.querySelector('[role="alert"]')?.textContent).toContain("Network problem");
});

it("explains an expired certificate and a missing key", () => {
  const expired = render({ status: status({ state: "expired", notAfter: NOW - DAY }) });
  expect(expired.container.querySelector('[role="alert"]')?.textContent).toContain("has expired");
  const missing = render({ status: status({ state: "key-missing" }) });
  expect(missing.container.querySelector('[role="alert"]')?.textContent).toContain(
    "no longer in the Android Keystore",
  );
});

it("re-enrolls with the same form and replaces the status when it works", async () => {
  const { container, handlers, button, type } = render({ status: status() });
  act(() => button("Re-enroll")!.click());
  type("Enrollment token", "fresh");
  await act(async () => button("Re-enroll")!.click());
  expect(handlers.onEnroll).toHaveBeenCalledWith("device-z-phone-mesh", "fresh");
  expect(container.textContent).toContain("Enrolled as device-z-phone-mesh");
});

it("confirms before removing the enrollment", () => {
  const { handlers, button } = render({ status: status() });
  act(() => button("Remove enrollment")!.click());
  expect(handlers.onRemove).not.toHaveBeenCalled();
  expect(dialog.confirm).toHaveBeenCalledOnce();
  const request = dialog.confirm.mock.calls[0]![0] as {
    destructive: boolean;
    onConfirm: () => void;
  };
  expect(request.destructive).toBe(true);
  request.onConfirm();
  expect(handlers.onRemove).toHaveBeenCalledOnce();
});

it("shows what a renewal came to, and the previous key's last day", () => {
  const { container } = render({
    status: status({ previous: { notAfter: NOW + 10 * DAY, keepUntil: NOW + 3 * DAY } }),
    notice: "Renewed. The previous key stays for a week.",
  });
  expect(container.textContent).toContain("The previous key is kept until Nov 21, 2026.");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Renewed.");
});

it("disables the actions while one runs", () => {
  const { button } = render({ status: status(), busy: "renew" });
  expect(button("Renew now")!.disabled).toBe(true);
  expect(button("Re-enroll")!.disabled).toBe(true);
  expect(button("Remove enrollment")!.disabled).toBe(true);
});
