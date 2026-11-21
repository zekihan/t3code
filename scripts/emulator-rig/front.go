package main

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

type tlsFront struct {
	listener net.Listener
	mesh     string
	viewer   string

	mu     sync.Mutex
	down   bool
	mode   string
	active map[net.Conn]struct{}
}

func (f *tlsFront) reset(down bool, mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.down, f.mode = down, mode
	f.closeConnections()
}

func (f *tlsFront) kill() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeConnections()
}

func (f *tlsFront) closeConnections() {
	for conn := range f.active {
		_ = conn.Close()
	}
}

func (f *tlsFront) whenUp(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		down := f.down
		f.mu.Unlock()
		if down {
			http.Error(w, "no available server", http.StatusServiceUnavailable)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (f *tlsFront) serve(ctx context.Context) error {
	defer f.kill()
	for {
		conn, err := f.listener.Accept()
		if err != nil {
			return err
		}
		f.mu.Lock()
		f.active[conn] = struct{}{}
		f.mu.Unlock()
		go f.route(ctx, conn)
	}
}

func (f *tlsFront) route(ctx context.Context, conn net.Conn) {
	defer func() {
		_ = conn.Close()
		f.mu.Lock()
		delete(f.active, conn)
		f.mu.Unlock()
	}()

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	hello := &sniffConn{Conn: conn}
	var host string
	_ = tls.Server(hello, &tls.Config{
		GetConfigForClient: func(info *tls.ClientHelloInfo) (*tls.Config, error) {
			host = info.ServerName
			return nil, io.EOF
		},
	}).HandshakeContext(ctx)
	_ = conn.SetReadDeadline(time.Time{})

	f.mu.Lock()
	down, mode := f.down, f.mode
	f.mu.Unlock()

	var target string
	switch host {
	case domain:
		if down {
			return
		}
		target = f.mesh
	case apiHost, viewerHost:
		if down && mode == "drop" {
			return
		}
		target = f.viewer
	default:
		return
	}

	dst, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", target)
	if err != nil {
		return
	}
	defer dst.Close()
	if _, err := dst.Write(hello.read); err != nil {
		return
	}

	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(dst, conn)
		_ = dst.Close()
		close(done)
	}()
	_, _ = io.Copy(conn, dst)
	_ = conn.Close()
	<-done
}

type sniffConn struct {
	net.Conn
	read []byte
}

func (c *sniffConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.read = append(c.read, p[:n]...)
	return n, err
}

// The real TLS endpoint must be the first to write bytes, including alerts.
func (*sniffConn) Write(p []byte) (int, error) { return len(p), nil }
