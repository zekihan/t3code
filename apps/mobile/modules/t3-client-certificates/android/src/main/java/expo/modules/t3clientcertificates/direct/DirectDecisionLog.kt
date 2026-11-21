package expo.modules.t3clientcertificates.direct

internal data class DirectDecision(
  val at: Long,
  val kind: String,
  val result: String,
  val host: String?
) {
  fun toMap() = mapOf("at" to at, "kind" to kind, "result" to result, "host" to host)
}

internal class DirectDecisionLog(
  private val clock: () -> Long,
  private val capacity: Int = 100
) {
  init {
    require(capacity > 0)
  }

  private val entries = ArrayDeque<DirectDecision>(capacity)

  @Synchronized
  fun record(kind: String, result: String, machine: String? = null) {
    if (entries.size == capacity) entries.removeFirst()
    entries.addLast(DirectDecision(clock(), kind, result, machine?.let(::viewerHost)))
  }

  @Synchronized
  fun snapshot(): List<DirectDecision> = entries.toList()
}
