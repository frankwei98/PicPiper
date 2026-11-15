package cloud

// ProcessingConcurrency returns the saved preference; zero selects Auto.
func (s *Service) ProcessingConcurrency() (int, error) {
	v, err := s.loadSettings()
	return v.ProcessingConcurrency, err
}
