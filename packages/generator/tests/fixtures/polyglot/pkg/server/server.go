package server

import "fmt"

// Server holds the listen address.
type Server struct {
	Addr string
}

// ListenAddr formats the address for logging.
func (s *Server) ListenAddr() string {
	return fmt.Sprintf("listening on %s", s.Addr)
}
