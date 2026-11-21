package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/zekihan/t3-mesh/internal/agent"
	"github.com/zekihan/t3-mesh/internal/agent/agentconfig"
	"github.com/zekihan/t3-mesh/internal/agent/state"
	"github.com/zekihan/t3-mesh/internal/hub"
	"github.com/zekihan/t3-mesh/internal/hub/enroll"
	"github.com/zekihan/t3-mesh/internal/hub/hubconfig"
	"github.com/zekihan/t3-mesh/internal/pki"
)

const (
	domain     = "mesh.noqer.com"
	apiHost    = "hub." + domain
	machine    = "rig"
	viewerHost = "t3." + machine + "." + domain
	viewerID   = "rig-viewer"
	agentID    = "agent-" + machine
	deviceID   = "device-rig-mesh"
)

func listen(addr string) (net.Listener, error) {
	return net.Listen("tcp4", addr)
}

func reservePorts(addr string) (int, int, error) {
	first, err := listen(net.JoinHostPort(addr, "0"))
	if err != nil {
		return 0, 0, err
	}
	defer first.Close()
	second, err := listen(net.JoinHostPort(addr, "0"))
	if err != nil {
		return 0, 0, err
	}
	defer second.Close()
	return first.Addr().(*net.TCPAddr).Port, second.Addr().(*net.TCPAddr).Port, nil
}

func run(ctx context.Context, dir, caddy, version string, lan netip.Addr) error {
	issuer, err := loadIssuer(dir, os.Getenv("A8_SEED"))
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	roots.AddCert(issuer.ca.Leaf)
	server := certificate(domain, 90)
	server.DNSNames = []string{domain, apiHost, viewerHost}
	server.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	if err := issuer.leaf(dir, "tls", server); err != nil {
		return err
	}
	if err := issuer.leaf(dir, "viewer", identityCertificate(viewerID)); err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key"))
	if err != nil {
		return err
	}
	clientCert, err := tls.LoadX509KeyPair(filepath.Join(dir, "viewer.crt"), filepath.Join(dir, "viewer.key"))
	if err != nil {
		return err
	}

	home := []string{"127.0.0.0/8", netip.PrefixFrom(lan, 32).String()}
	config := fmt.Sprintf(`
machines:
  %s: {identity: %s, services: {t3: {kind: http}}}
homeCIDRs: [%s, %s]
viewerDomain: %s
release: {version: %s}
api: {identities: [%s, %s]}
devices: [%s]
policy:
  entries:
    mesh-t3-%s: {identities: [%s, %s]}
`, machine, agentID, home[0], home[1], domain, version, viewerID, deviceID, deviceID, machine, viewerID, deviceID)
	if err := writeFile(dir, hubconfig.ConfigFile, []byte(config)); err != nil {
		return err
	}
	if err := writeFile(dir, hubconfig.RevFile, []byte(pki.Fingerprint(issuer.ca.Leaf))); err != nil {
		return err
	}
	logger := slog.Default()
	watcher, err := hubconfig.NewWatcher(hubconfig.Paths{ConfigDir: dir, TrustDir: dir, CertDir: dir}, logger)
	if err != nil {
		return err
	}
	tokens := enroll.NewTokens(time.Now)
	h, err := hub.New(hub.Options{Config: watcher, Issuer: issuer, Tokens: tokens, Log: logger})
	if err != nil {
		return err
	}

	agentPort, devicePort, err := reservePorts(lan.String())
	if err != nil {
		return err
	}
	identityDir := filepath.Join(dir, "agent")
	store := pki.Store{Dir: identityDir}
	if err := store.EnsureDir(); err != nil {
		return err
	}
	agentKey, _, err := newKey()
	if err != nil {
		return err
	}
	if err := store.SaveKey(agentKey); err != nil {
		return err
	}
	agentPEM, err := issuer.sign(identityCertificate(agentID), &agentKey.PublicKey)
	if err != nil {
		return err
	}
	if err := store.SaveCert(agentPEM, issuer.caPEM); err != nil {
		return err
	}
	stateDir := filepath.Join(dir, "agent-state")
	const gateway = "02:00:00:00:00:01"
	cache := &state.Cache{
		Home: true, HomeCIDRs: home, HomeGatewayMAC: gateway, Machine: machine,
		LastHubContact: time.Now(), TrustBundle: watcher.Current().TrustBundle, ViewerDomain: domain,
		Rules: watcher.Current().Rules,
	}
	if err := state.Save(stateDir, cache); err != nil {
		return err
	}
	frontListener, err := listen("127.0.0.1:0")
	if err != nil {
		return err
	}
	defer frontListener.Close()
	meshListener, err := listen("127.0.0.1:0")
	if err != nil {
		return err
	}
	defer meshListener.Close()
	viewerListener, err := listen("127.0.0.1:0")
	if err != nil {
		return err
	}
	defer viewerListener.Close()
	backendListener, err := listen("127.0.0.1:0")
	if err != nil {
		return err
	}
	defer backendListener.Close()
	controlListener, err := listen("127.0.0.1:0")
	if err != nil {
		return err
	}
	defer controlListener.Close()

	f := &tlsFront{
		listener: frontListener, mesh: meshListener.Addr().String(),
		viewer: viewerListener.Addr().String(), active: make(map[net.Conn]struct{}),
	}
	backendProxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "https", Host: caddy})
	backendProxy.Transport = &http.Transport{TLSClientConfig: &tls.Config{
		ServerName: viewerHost, RootCAs: roots, Certificates: []tls.Certificate{clientCert},
	}}
	a, err := agent.New(agent.Options{
		Config: &agentconfig.Config{
			Identity: agentconfig.Identity{Name: agentID, Dir: identityDir},
			Hub:      frontListener.Addr().String(), StateDir: stateDir, InstallDir: filepath.Join(dir, "agent-install"),
			Serve: map[string]string{"t3": backendListener.Addr().String()},
			Direct: agentconfig.Direct{
				Enabled: true, Port: agentPort, CacheTTL: 168 * time.Hour,
				Devices: agentconfig.Devices{Enabled: true, Port: devicePort},
			},
		},
		HubTLS:     &tls.Config{RootCAs: roots, ServerName: domain},
		GatewayMAC: func() (string, error) { return gateway, nil },
		LocalAddrs: func() ([]netip.Addr, error) { return []netip.Addr{lan}, nil },
		Version:    version,
	})
	if err != nil {
		return err
	}
	admin := &enroll.Admin{Tokens: tokens, Allowed: h.EnrollTokenAllowed, Path: filepath.Join(dir, "admin.sock")}
	viewerServer := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: f.whenUp(authenticateViewer(h.ViewerHandler(), lan))}
	viewerTLS := tls.NewListener(viewerListener, &tls.Config{
		MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert},
		ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots, NextProtos: []string{"http/1.1"},
	})
	backendServer := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: backendProxy}
	controlServer := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: controlHandler(f, admin.Path)}

	errs := make(chan error, 7)
	go func() { errs <- h.ServeTunnels(ctx, meshListener) }()
	go func() { errs <- f.serve(ctx) }()
	go func() { errs <- viewerServer.Serve(viewerTLS) }()
	go func() { errs <- backendServer.Serve(backendListener) }()
	go func() { errs <- controlServer.Serve(controlListener) }()
	go func() { errs <- admin.Serve(ctx) }()
	go func() { errs <- a.Run(ctx) }()
	defer viewerServer.Close()
	defer backendServer.Close()
	defer controlServer.Close()

	addresses := fmt.Sprintf("FRONT_PORT=%d\nCONTROL_URL=http://%s\nDEVICE_ADDRESS=%s\n",
		frontListener.Addr().(*net.TCPAddr).Port, controlListener.Addr(), net.JoinHostPort(lan.String(), strconv.Itoa(devicePort)))
	if err := writeFile(dir, "addresses", []byte(addresses)); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return nil
	case err := <-errs:
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("rig service stopped: %v", err)
	}
}

func authenticateViewer(next http.Handler, lan netip.Addr) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaf := r.TLS.PeerCertificates[0]
		if len(leaf.URIs) != 1 || (r.Host != apiHost && r.Host != viewerHost) || r.Host != r.TLS.ServerName {
			http.Error(w, "invalid viewer", http.StatusForbidden)
			return
		}
		r.Header.Set(hub.HeaderViewer, leaf.URIs[0].String())
		r.Header.Set(hub.HeaderFingerprint, pki.Fingerprint(leaf))
		r.Header.Set(hub.HeaderNotAfter, leaf.NotAfter.Format(time.RFC3339))
		r.Header.Set("X-Real-IP", lan.String())
		next.ServeHTTP(w, r)
	})
}

func controlHandler(f *tlsFront, adminPath string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /hub", func(w http.ResponseWriter, r *http.Request) {
		up, mode := r.URL.Query().Get("up"), r.URL.Query().Get("mode")
		if mode == "" {
			mode = "503"
		}
		if (up != "0" && up != "1") || (mode != "503" && mode != "drop") {
			http.Error(w, "use up=0 or up=1 and mode=503 or mode=drop", http.StatusBadRequest)
			return
		}
		f.reset(up == "0", mode)
		fmt.Fprintf(w, "hub up=%s mode=%s\n", up, mode)
	})
	mux.HandleFunc("GET /front/kill", func(w http.ResponseWriter, _ *http.Request) {
		f.kill()
		fmt.Fprintln(w, "front connections closed")
	})
	mux.HandleFunc("POST /enroll", func(w http.ResponseWriter, r *http.Request) {
		token, _, err := enroll.RequestToken(r.Context(), adminPath, enroll.KindDevice, deviceID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, token)
	})
	return mux
}

func main() {
	if len(os.Args) != 5 {
		log.Fatal("usage: emulator-rig <scratch-dir> <caddy-address> <host-lan-ipv4> <mesh-version>")
	}
	lan, err := netip.ParseAddr(os.Args[3])
	if err != nil || !lan.Is4() || !lan.IsPrivate() {
		log.Fatal("the device listener needs an RFC 1918 IPv4 address assigned to the host")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1], os.Args[2], os.Args[4], lan); err != nil {
		log.Fatal(err)
	}
}
