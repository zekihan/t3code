package expo.modules.t3clientcertificates

import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import javax.net.ssl.HostnameVerifier
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderFactoryGuardTest {
  private val marker = HostnameVerifier { _, _ -> false }
  private val guard = ProviderFactoryGuard { it.hostnameVerifier(marker) }

  @After
  fun reset() = OkHttpClientProvider.setOkHttpClientFactory(null)

  @Test
  fun reads_the_provider_factory() {
    guard.install()
    assertSame(guard.factory, currentProviderFactory())
  }

  @Test
  fun wraps_a_factory_that_replaced_it_and_keeps_its_interceptors() {
    guard.install()
    val metrics = Interceptor { it.proceed(it.request()) }
    OkHttpClientProvider.setOkHttpClientFactory(
      OkHttpClientFactory {
        OkHttpClientProvider.createClientBuilder().addInterceptor(metrics).build()
      }
    )

    guard.reassert()

    assertSame(guard.factory, currentProviderFactory())
    val client: OkHttpClient = OkHttpClientProvider.createClient()
    assertSame(marker, client.hostnameVerifier)
    assertTrue(client.interceptors.contains(metrics))
  }

  @Test
  fun leaves_its_own_factory_alone() {
    guard.install()
    guard.reassert()
    assertSame(guard.factory, currentProviderFactory())
    assertNotNull(OkHttpClientProvider.createClient())
  }
}
