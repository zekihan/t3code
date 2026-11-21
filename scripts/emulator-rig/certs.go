package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zekihan/t3-mesh/internal/pki"
	"github.com/zekihan/t3-mesh/internal/policy"
)

type testIssuer struct {
	ca     tls.Certificate
	caPEM  []byte
	mu     sync.Mutex
	newest map[string]string
}

func writeFile(dir, name string, data []byte) error {
	return os.WriteFile(filepath.Join(dir, name), data, 0600)
}

func certificate(name string, days int) *x509.Certificate {
	now := time.Now()
	return &x509.Certificate{
		Subject:   pkix.Name{CommonName: name},
		NotBefore: now.Add(-time.Hour),
		NotAfter:  now.Add(time.Duration(days)*24*time.Hour - time.Hour),
		KeyUsage:  x509.KeyUsageDigitalSignature,
	}
}

func writePair(dir, name string, cert, key []byte) error {
	if err := writeFile(dir, name+".key", key); err != nil {
		return err
	}
	return writeFile(dir, name+".crt", cert)
}

func sign(template, parent *x509.Certificate, public, signer any) ([]byte, error) {
	der, err := x509.CreateCertificate(rand.Reader, template, parent, public, signer)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), nil
}

func newKey() (*ecdsa.PrivateKey, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return key, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
}

func loadIssuer(dir, seed string) (*testIssuer, error) {
	caPath := filepath.Join(dir, "ca.crt")
	if _, err := os.Stat(caPath); os.IsNotExist(err) {
		key, keyPEM, err := newKey()
		if err != nil {
			return nil, err
		}
		ca := certificate("T3 Mesh Emulator Test CA", 3650)
		ca.IsCA = true
		ca.BasicConstraintsValid = true
		ca.KeyUsage |= x509.KeyUsageCertSign
		certPEM, err := sign(ca, ca, &key.PublicKey, key)
		if err != nil {
			return nil, err
		}
		if err := writePair(dir, "ca", certPEM, keyPEM); err != nil {
			return nil, err
		}
	}
	ca, err := tls.LoadX509KeyPair(caPath, filepath.Join(dir, "ca.key"))
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, err
	}
	issuer := &testIssuer{ca: ca, caPEM: caPEM, newest: make(map[string]string)}
	if seed != "" {
		identity, fingerprint, ok := strings.Cut(seed, "=")
		decoded, err := hex.DecodeString(fingerprint)
		if !ok || !policy.IsDevice(identity) || len(decoded) != 32 || err != nil {
			return nil, fmt.Errorf("A8_SEED must be device-<name>-mesh=<leaf SHA-256>")
		}
		issuer.newest[identity] = strings.ToLower(fingerprint)
	}
	return issuer, nil
}

func (issuer *testIssuer) sign(tmpl *x509.Certificate, public any) ([]byte, error) {
	return sign(tmpl, issuer.ca.Leaf, public, issuer.ca.PrivateKey)
}

func (issuer *testIssuer) leaf(dir, name string, tmpl *x509.Certificate) error {
	key, keyPEM, err := newKey()
	if err != nil {
		return err
	}
	certPEM, err := issuer.sign(tmpl, &key.PublicKey)
	if err != nil {
		return err
	}
	return writePair(dir, name, certPEM, keyPEM)
}

func identityCertificate(identity string) *x509.Certificate {
	uri, _ := url.Parse(policy.IdentityURI(identity))
	days := 365
	if policy.IsAgent(identity) {
		// The mesh agent renews any identity leaf within 90 days of expiry.
		days = 120
	}
	cert := certificate(identity, days)
	cert.URIs = []*url.URL{uri}
	cert.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	if policy.IsAgent(identity) {
		cert.ExtKeyUsage = append(cert.ExtKeyUsage, x509.ExtKeyUsageServerAuth)
	}
	return cert
}

func (issuer *testIssuer) Issue(_ context.Context, identity string, csrPEM []byte) ([]byte, []byte, error) {
	csr, requested, err := pki.ValidateCSR(csrPEM)
	if err != nil {
		return nil, nil, err
	}
	if requested != identity {
		return nil, nil, fmt.Errorf("CSR identity %q does not match %q", requested, identity)
	}
	leafPEM, err := issuer.sign(identityCertificate(identity), csr.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	certs, err := pki.ParseCertsPEM(leafPEM)
	if err != nil {
		return nil, nil, err
	}
	issuer.mu.Lock()
	issuer.newest[identity] = pki.Fingerprint(certs[0])
	issuer.mu.Unlock()
	return leafPEM, issuer.caPEM, nil
}

func (issuer *testIssuer) Newest(_ context.Context, identity string) (string, error) {
	issuer.mu.Lock()
	defer issuer.mu.Unlock()
	return issuer.newest[identity], nil
}

func (*testIssuer) Prune(context.Context, string, int) error { return nil }
