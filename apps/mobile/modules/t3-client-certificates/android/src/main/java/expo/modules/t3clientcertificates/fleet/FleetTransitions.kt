package expo.modules.t3clientcertificates.fleet

internal enum class T3Health {
  ABSENT,
  UNKNOWN,
  REACHABLE,
  UNREACHABLE
}

internal data class FleetMachine(
  val online: Boolean,
  val t3: T3Health,
  val alerts: Set<String>,
  val unavailable: Boolean = !online || t3 == T3Health.UNREACHABLE
)

internal data class FleetEnrollment(
  val issuedAt: Long,
  val needsReenrollment: Boolean,
  val renewalFailed: Boolean,
  val hubRefused: Boolean = false
) {
  fun notice(): EnrollmentNotice? = when {
    needsReenrollment || hubRefused -> EnrollmentNotice.REENROLL
    renewalFailed -> EnrollmentNotice.RENEWAL_FAILED
    else -> null
  }
}

internal data class FleetSnapshot(
  val machines: Map<String, FleetMachine>?,
  val enrollment: FleetEnrollment?
)

internal enum class EnrollmentNotice { REENROLL, RENEWAL_FAILED }

internal data class FleetChanges(
  val down: List<String> = emptyList(),
  val back: List<String> = emptyList(),
  val alerts: List<String> = emptyList(),
  val enrollment: EnrollmentNotice? = null
)

internal data class FleetUpdate(val state: FleetSnapshot, val changes: FleetChanges)

internal fun fleetTransitions(
  previous: FleetSnapshot?,
  fleet: Map<String, FleetMachine>?,
  enrollment: FleetEnrollment?,
  hubRefused: Boolean = false
): FleetUpdate {
  val oldFleet = previous?.machines
  val oldEnrollment = previous?.enrollment
  val stillRefused = fleet == null && oldEnrollment?.hubRefused == true &&
    oldEnrollment.issuedAt == enrollment?.issuedAt
  val nextEnrollment = enrollment?.copy(hubRefused = hubRefused || stillRefused)
  val oldNotice = oldEnrollment?.notice()
  val notice = nextEnrollment?.notice().takeIf { previous != null && it != oldNotice }
  val nextFleet = fleet?.mapValues { (name, machine) ->
    // After a reconnect the hub reports unknown until the agent probes T3 again.
    if (machine.online && machine.t3 == T3Health.UNKNOWN &&
      oldFleet?.get(name)?.unavailable == true
    ) {
      machine.copy(unavailable = true)
    } else {
      machine
    }
  }
  return FleetUpdate(
    FleetSnapshot(nextFleet ?: oldFleet, nextEnrollment),
    compareFleet(oldFleet, nextFleet, notice)
  )
}

private fun compareFleet(
  previous: Map<String, FleetMachine>?,
  next: Map<String, FleetMachine>?,
  enrollmentNotice: EnrollmentNotice?
): FleetChanges {
  if (previous == null || next == null) return FleetChanges(enrollment = enrollmentNotice)
  val down = mutableListOf<String>()
  val back = mutableListOf<String>()
  val alerts = mutableListOf<String>()
  for ((name, machine) in next.toSortedMap()) {
    val old = previous[name]
    val tunnelDropped = old?.online == true && !machine.online
    val newOutage = old?.unavailable == false && machine.unavailable
    if (tunnelDropped || newOutage) down += name
    if (old?.unavailable == true && !machine.unavailable) back += name
    if (machine.alerts.any { it !in old?.alerts.orEmpty() }) alerts += name
  }
  return FleetChanges(down, back, alerts, enrollmentNotice)
}
