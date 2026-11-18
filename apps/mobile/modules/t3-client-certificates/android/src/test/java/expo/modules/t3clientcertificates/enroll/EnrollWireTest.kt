package expo.modules.t3clientcertificates.enroll

import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class EnrollWireTest {
  @Test fun theEnrollRequestIsByteForByteWhatProtoWriteMessageWrites() {
    val frame = EnrollWire.enrollRequest(HubFixtures.ENROLL_TOKEN, HubFixtures.CSR_PEM)
    assertEquals(HubFixtures.ENROLL_FRAME_HEX, hex(frame))
  }

  @Test fun theRequestStartsWithABigEndianLengthOfTheJson() {
    val frame = EnrollWire.enrollRequest("t", "c")
    val json = String(frame, 4, frame.size - 4)
    assertEquals("{\"type\":\"Enroll\",\"body\":{\"token\":\"t\",\"csr\":\"c\"}}", json)
    val length = ((frame[0].toInt() and 0xFF) shl 24) or ((frame[1].toInt() and 0xFF) shl 16) or
      ((frame[2].toInt() and 0xFF) shl 8) or (frame[3].toInt() and 0xFF)
    assertEquals(json.length, length)
  }

  @Test fun anOversizedRequestIsNotSent() {
    try {
      EnrollWire.enrollRequest("t", "x".repeat(EnrollWire.MAX_REQUEST_BYTES))
      fail("sent a request the hub would refuse")
    } catch (_: IOException) {
      // expected
    }
    // The largest request the hub takes: the length counts the JSON, at most 4096 bytes.
    val fits = "x".repeat(EnrollWire.MAX_REQUEST_BYTES - 60)
    assertTrue(EnrollWire.enrollRequest("t", fits).size <= EnrollWire.MAX_REQUEST_BYTES + 4)
  }

  @Test fun enrolledReplyFromTheHubsFraming() {
    val reply = EnrollWire.readReply(ByteArrayInputStream(unhex(HubFixtures.ENROLLED_FRAME_HEX)))
    assertEquals(EnrollWire.Reply.Enrolled("LEAF\n", "CHAIN\n", null, null), reply)
  }

  @Test fun rejectReplyFromTheHubsFraming() {
    val reply = EnrollWire.readReply(ByteArrayInputStream(unhex(HubFixtures.REJECT_FRAME_HEX)))
    assertEquals(EnrollWire.Reply.Reject("enroll-failed", "invalid token"), reply)
  }

  @Test fun theClientsCaBundleAndRevisionAreRead() {
    val reply =
      EnrollWire.parseReply(
        "{\"type\":\"Enrolled\",\"body\":{\"certificate\":\"a\",\"chain\":\"b\"," +
          "\"caBundle\":\"c\",\"caRevision\":\"r7\"}}"
      )
    assertEquals(EnrollWire.Reply.Enrolled("a", "b", "c", "r7"), reply)
  }

  @Test fun anEmptyBundleCountsAsNone() {
    val reply =
      EnrollWire.parseReply(
        "{\"type\":\"Enrolled\",\"body\":{\"certificate\":\"a\",\"caBundle\":\"\"}}"
      )
    assertEquals(EnrollWire.Reply.Enrolled("a", "", null, null), reply)
  }

  @Test fun otherMessageTypesAreReportedNotParsedAsOurs() {
    val reply = EnrollWire.parseReply("{\"type\":\"Pong\",\"body\":{\"seq\":1}}")
    assertEquals(EnrollWire.Reply.Unexpected("Pong"), reply)
  }

  @Test fun malformedRepliesFail() {
    for (bad in listOf("", "not json", "{}", "{\"type\":\"Enrolled\",\"body\":{}}")) {
      try {
        EnrollWire.parseReply(bad)
        fail("parsed $bad")
      } catch (_: IOException) {
        // expected
      }
    }
  }

  @Test fun truncatedOrOversizedFramesFail() {
    val frame = unhex(HubFixtures.ENROLLED_FRAME_HEX)
    for (cut in listOf(0, 2, 4, frame.size - 1)) {
      try {
        EnrollWire.readReply(ByteArrayInputStream(frame.copyOf(cut)))
        fail("read a frame cut at $cut")
      } catch (_: IOException) {
        // expected
      }
    }
    try {
      EnrollWire.readReply(ByteArrayInputStream(frame), limit = 10)
      fail("read a frame over the limit")
    } catch (_: IOException) {
      // expected
    }
    try {
      EnrollWire.readReply(ByteArrayInputStream(byteArrayOf(0xFF.toByte(), 0, 0, 0)))
      fail("read a negative length")
    } catch (_: IOException) {
      // expected
    }
  }

  @Test fun quotingMatchesGoWithoutHtmlEscaping() {
    assertEquals("\"a/b\\\"c\\\\d\\n\\r\\t\\u0001é\"", EnrollWire.quote("a/b\"c\\d\n\r\t\u0001é"))
    assertEquals("\"<&>\"", EnrollWire.quote("<&>"))
  }
}
