package expo.modules.t3clientcertificates.direct

import expo.modules.t3clientcertificates.enroll.NOW
import expo.modules.t3clientcertificates.enroll.TestCa
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectHubTest {
  private val ca = TestCa("clients CA")
  private val fp = "ab".repeat(32)

  private fun fleet(caller: String = """{"path":"LAN"}""", machines: String) =
    """{"caller":$caller,"machines":[$machines]}"""

  private fun machine(
    name: String = "z-arch",
    url: String = "https://t3.$name.mesh.noqer.com",
    direct: String = """{"address":"192.168.2.41","port":27443}""",
    identity: String = "agent-$name"
  ) =
    """{"name":"$name","viewerUrl":"$url","direct":$direct,""" +
      """"agentIdentity":"$identity","online":true}"""

  @Test fun theGateIsHomeOnlyForALanCaller() {
    assertEquals(HubGate.HOME, HubParsing.fleet(fleet(machines = machine()), NOW)!!.gate)
    listOf("""{"path":"OCI"}""", """{"path":null}""", """{}""", "null").forEach {
      assertEquals(
        it,
        HubGate.AWAY,
        HubParsing.fleet(fleet(caller = it, machines = machine()), NOW)!!.gate
      )
    }
  }

  @Test fun aMachineWithADirectRouteGetsOneAndOneWithoutGetsNone() {
    val body = fleet(machines = machine() + "," + machine("z-mac", direct = "null"))
    val answer = HubParsing.fleet(body, NOW)!!
    assertEquals(
      mapOf("z-arch" to DirectRoute("z-arch", "192.168.2.41", 27443, "agent-z-arch", NOW)),
      answer.routes
    )
  }

  @Test fun aRouteForTheWrongIdentityAddressOrViewerUrlIsDropped() {
    val body =
      fleet(
        machines =
          listOf(
            machine("a", identity = "agent-b"),
            machine("b", direct = """{"address":"8.8.8.8","port":27443}"""),
            machine("c", direct = """{"address":"192.168.2.43","port":0}"""),
            machine("d", url = "https://t3.other.mesh.noqer.com"),
            machine("e", direct = """{"address":"192.168.2.45"}"""),
            machine("f")
          ).joinToString(",")
      )
    assertEquals(setOf("f"), HubParsing.fleet(body, NOW)!!.routes.keys)
  }

  @Test fun aRepeatedMachineKeepsTheFirstEntry() {
    val body = fleet(
      machines =
        machine() + "," + machine(direct = """{"address":"192.168.2.99","port":1}""")
    )
    assertEquals("192.168.2.41", HubParsing.fleet(body, NOW)!!.routes.getValue("z-arch").address)
  }

  @Test fun somethingThatIsNotAFleetIsNotAnAnswer() {
    assertNull(HubParsing.fleet("not json", NOW))
    assertNull(HubParsing.fleet("""{"caller":{"path":"LAN"}}""", NOW))
    assertNull(HubParsing.fleet("[]", NOW))
  }

  private fun trustBody(
    bundle: String = ca.certificatePem,
    revision: String = "rev-1",
    revoked: String = """["$fp"]"""
  ) = org.json.JSONObject().put("caBundle", bundle).put("caRevision", revision)
    .put("revokedAgents", org.json.JSONArray(revoked)).toString()

  @Test fun theTrustIsTheBundleTheRevisionAndTheRevokedLeaves() {
    val trust = HubParsing.trust(trustBody(), NOW)!!
    assertEquals(DirectTrust(ca.certificatePem, "rev-1", setOf(fp), NOW), trust)
    assertNotNull(HubParsing.trust(trustBody(revoked = "[]"), NOW))
  }

  @Test fun aTrustAnswerWithAnythingUnusableIsRefusedWhole() {
    assertNull(HubParsing.trust(trustBody(bundle = ""), NOW))
    assertNull(HubParsing.trust(trustBody(bundle = "garbage"), NOW))
    assertNull(HubParsing.trust(trustBody(revision = ""), NOW))
    assertNull(HubParsing.trust(trustBody(revoked = """["not-a-fingerprint"]"""), NOW))
    assertNull(HubParsing.trust(trustBody(revoked = """["${fp.uppercase()}"]"""), NOW))
    assertNull(HubParsing.trust("""{"caBundle":"x"}""", NOW))
    assertNull(HubParsing.trust("nope", NOW))
  }

  @Test fun theHubClientAsksFleetAndTrustAndReportsAFailureAsFailed() {
    val server = MockWebServer().apply { start() }
    try {
      val hub = DirectHub(OkHttpClient(), { NOW }, server.url("/").toString().trimEnd('/'))
      server.enqueue(MockResponse().setBody(fleet(machines = machine())))
      server.enqueue(MockResponse().setBody(trustBody()))
      server.enqueue(MockResponse().setResponseCode(403))
      server.enqueue(MockResponse().setBody("<html>"))
      assertTrue(hub.fleet() is HubReply.Ok)
      assertTrue(hub.trust() is HubReply.Ok)
      assertTrue(hub.fleet() is HubReply.Failed)
      assertTrue(hub.trust() is HubReply.Failed)
      assertEquals("/api/v1/fleet", server.takeRequest().path)
      assertEquals("/api/v1/trust", server.takeRequest().path)
    } finally {
      server.shutdown()
    }
    assertTrue(DirectHub(OkHttpClient(), { NOW }, "http://127.0.0.1:1").fleet() is HubReply.Failed)
  }
}
