import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { IDENTITY_SUGGESTIONS, identityProblem, summarizeEnrollment } from "./meshEnrollmentLogic";
import type { MeshEnrollmentState } from "./useMeshEnrollment";

interface MeshEnrollmentViewProps {
  readonly state: MeshEnrollmentState;
  /** Resolves true when the device is enrolled. */
  readonly onEnroll: (identity: string, token: string) => Promise<boolean>;
  readonly onRenew: () => void;
  readonly onRemove: () => void;
  /** Opens the form straight away; the screen uses it when a hub problem asks for enrollment. */
  readonly startWithForm?: boolean;
}

/** What the Device tab shows for a state; the view and its tests share it. */
export function enrollmentViewKind(state: MeshEnrollmentState, formOpen: boolean) {
  if (!state.available) return "unavailable" as const;
  if (!state.loaded) return "loading" as const;
  if (formOpen) return "form" as const;
  return state.status === null ? ("intro" as const) : ("status" as const);
}

function EnrollmentForm(props: {
  readonly state: MeshEnrollmentState;
  readonly initialIdentity: string;
  readonly reenroll: boolean;
  readonly onSubmit: (identity: string, token: string) => void;
  readonly onCancel: () => void;
}) {
  const [identity, setIdentity] = useState(props.initialIdentity);
  const [token, setToken] = useState("");
  const enrolling = props.state.busy === "enroll";
  const name = identity.trim();
  const problem = name.length === 0 ? null : identityProblem(name);
  const ready = identityProblem(name) === null && token.trim().length > 0;
  return (
    <View className="gap-3" accessibilityLabel="Enroll this device">
      <View className="gap-2 rounded-[26px] border-continuous bg-grouped-card px-4 py-4">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {props.reenroll ? "Re-enroll this device" : "Enroll this device"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {props.reenroll
            ? "A new key replaces the current one as soon as the hub accepts the token."
            : "This device gets its own identity, with a key that never leaves the Android Keystore."}
        </Text>
        <Text className="pt-2 text-xs text-foreground-muted">Identity name</Text>
        <AppTextInput
          accessibilityLabel="Identity name"
          value={identity}
          editable={!enrolling}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="device-z-phone-mesh"
          onChangeText={setIdentity}
        />
        <View className="flex-row flex-wrap gap-2">
          {IDENTITY_SUGGESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              tone="secondary"
              size="compact"
              label={suggestion}
              disabled={enrolling}
              onPress={() => setIdentity(suggestion)}
            />
          ))}
        </View>
        {problem ? <Text className="text-xs text-danger-foreground">{problem}</Text> : null}
        <Text className="pt-2 text-xs text-foreground-muted">Enrollment token</Text>
        <AppTextInput
          accessibilityLabel="Enrollment token"
          value={token}
          editable={!enrolling}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste the one-time token"
          onChangeText={setToken}
        />
        <Text className="text-xs text-foreground-muted">
          Create it on the hub with t3-mesh-hub enroll-token --device {name || "<name>"}. It works
          once, for 15 minutes.
        </Text>
      </View>
      {enrolling ? (
        <View className="flex-row items-center gap-3 px-1" accessibilityLabel="Enrolling">
          <AppActivityIndicator />
          <Text className="text-foreground-muted">Contacting mesh.noqer.com…</Text>
        </View>
      ) : null}
      {props.state.failure ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={`${props.state.failure.title}. ${props.state.failure.detail}`}
        />
      ) : null}
      <View className="flex-row gap-3">
        <Button
          tone="primary"
          label={props.reenroll ? "Re-enroll" : "Enroll"}
          disabled={!ready}
          loading={enrolling}
          onPress={() => props.onSubmit(name, token.trim())}
        />
        <Button tone="text" label="Cancel" disabled={enrolling} onPress={props.onCancel} />
      </View>
    </View>
  );
}

function EnrollmentStatusCard(props: {
  readonly state: MeshEnrollmentState;
  readonly onRenew: () => void;
  readonly onReenroll: () => void;
  readonly onRemove: () => void;
}) {
  const { state } = props;
  const status = state.status!;
  const summary = summarizeEnrollment(status, state.now);
  const working = state.busy !== null;
  // The banner above already says the hub refused the leaf.
  const failure =
    summary.needsReenroll && state.failure?.code === "REENROLL_REQUIRED" ? null : state.failure;
  return (
    <View className="gap-3">
      {summary.needsReenroll ? (
        <Notice tone="danger" icon="exclamationmark.triangle" message={summary.needsReenroll} />
      ) : null}
      <View className="gap-1 rounded-[26px] border-continuous bg-grouped-card px-4 py-4">
        <Text textRole="body" className="font-t3-medium text-foreground">
          {summary.headline}
        </Text>
        <Text className="text-sm text-foreground">{summary.expires}</Text>
        <Text className="text-sm text-foreground">{summary.renewal}</Text>
        <Text className="text-xs text-foreground-muted">{summary.key}</Text>
        {summary.previous ? (
          <Text className="text-xs text-foreground-muted">{summary.previous}</Text>
        ) : null}
        {summary.lastRenewalProblem ? (
          <Text className="text-xs text-foreground-muted">{summary.lastRenewalProblem}</Text>
        ) : null}
        <Text className="pt-1 text-xs text-foreground-muted">
          Mesh hosts use this identity instead of the certificate chosen in KeyChain.
        </Text>
      </View>
      {failure ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={`${failure.title}. ${failure.detail}`}
        />
      ) : null}
      {state.notice ? <Notice icon="checkmark.circle" message={state.notice} /> : null}
      <View className="flex-row flex-wrap gap-3">
        <Button
          tone="secondary"
          label="Renew now"
          disabled={working || status.state !== "valid"}
          loading={state.busy === "renew"}
          onPress={props.onRenew}
        />
        <Button tone="secondary" label="Re-enroll" disabled={working} onPress={props.onReenroll} />
        <Button
          tone="danger"
          label="Remove enrollment"
          disabled={working}
          loading={state.busy === "remove"}
          onPress={props.onRemove}
        />
      </View>
    </View>
  );
}

/** The Mesh screen's Device tab: enroll this device, see its identity, renew, re-enroll or remove it. */
export function MeshEnrollmentView(props: MeshEnrollmentViewProps) {
  const { state } = props;
  const [formOpen, setFormOpen] = useState(props.startWithForm === true);
  const kind = enrollmentViewKind(state, formOpen);
  if (kind === "unavailable") {
    return (
      <EmptyState
        variant="plain"
        title="Enrollment needs the Android app"
        detail="Device enrollment keeps its key in the Android Keystore, which this build does not have."
      />
    );
  }
  if (kind === "loading") {
    return (
      <View className="items-center gap-3 px-8 py-12" accessibilityLabel="Loading enrollment">
        <AppActivityIndicator />
      </View>
    );
  }
  if (kind === "intro") {
    return (
      <EmptyState
        variant="plain"
        title="This device is not enrolled"
        detail="Enroll with a one-time token to give this device its own mesh identity. Its key is created in the Android Keystore and cannot be exported. Until then mesh hosts use the certificate chosen in KeyChain."
        actionLabel="Enroll this device"
        onAction={() => setFormOpen(true)}
      />
    );
  }
  if (kind === "form") {
    return (
      <EnrollmentForm
        state={state}
        initialIdentity={state.status?.identity ?? IDENTITY_SUGGESTIONS[0]}
        reenroll={state.status !== null}
        onSubmit={(identity, token) => {
          void props.onEnroll(identity, token).then((enrolled) => {
            if (enrolled) setFormOpen(false);
          });
        }}
        onCancel={() => setFormOpen(false)}
      />
    );
  }
  return (
    <EnrollmentStatusCard
      state={state}
      onRenew={props.onRenew}
      onReenroll={() => setFormOpen(true)}
      onRemove={() =>
        Dialog.confirm({
          title: "Remove enrollment?",
          message:
            "The key is deleted from the Android Keystore. Mesh hosts go back to the certificate chosen in KeyChain, if there is one.",
          confirmText: "Remove",
          destructive: true,
          onConfirm: props.onRemove,
        })
      }
    />
  );
}
