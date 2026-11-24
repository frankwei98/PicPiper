package cloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxS3UploadBytes = 5 << 30

// canonicalPath can resolve a destination before its directory is created.
// A dangling symlink is still an existing component and must not be treated
// as a directory that the app can create.
func canonicalPath(path string) (string, error) {
	if path == "" {
		return "", os.ErrInvalid
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	for ancestor := path; ; ancestor = filepath.Dir(ancestor) {
		resolved, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			remainder, err := filepath.Rel(ancestor, path)
			if err != nil {
				return "", err
			}
			return filepath.Join(resolved, remainder), nil
		}
		if !errors.Is(err, os.ErrNotExist) || filepath.Dir(ancestor) == ancestor {
			return "", err
		}
		if _, err := os.Lstat(ancestor); !errors.Is(err, os.ErrNotExist) {
			return "", os.ErrInvalid
		}
	}
}

func pathWithin(path, dir string) bool {
	relative, err := filepath.Rel(dir, path)
	if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return true
	}
	// Case-insensitive volumes can address the same directory under a different
	// spelling even after symlink resolution.
	root, err := os.Stat(dir)
	if err != nil {
		return false
	}
	for candidate := path; ; candidate = filepath.Dir(candidate) {
		if current, err := os.Stat(candidate); err == nil && os.SameFile(current, root) {
			return true
		}
		if filepath.Dir(candidate) == candidate {
			return false
		}
	}
}

func (s *Service) resolveUploadPath(path, readErrorCode string) (string, error) {
	dir, err := canonicalPath(s.dataDir)
	if err != nil {
		return "", appErr(readErrorCode, "Could not verify the selected image file.")
	}
	source, err := canonicalPath(path)
	if err != nil {
		return "", appErr(readErrorCode, "Could not open the selected image file.")
	}
	if pathWithin(source, dir) {
		cache := filepath.Join(dir, "optimizer-cache")
		info, err := os.Lstat(cache)
		if err != nil || info.Mode().Type() != os.ModeDir || !pathWithin(source, cache) {
			return "", appErr("invalidSourcePath", "Choose an image outside Pic Piper’s private data folder.")
		}
	}
	return source, nil
}

func (s *Service) checkUploadSourceIdentity(source os.FileInfo, readErrorCode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	check := func(path string) error {
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return appErr(readErrorCode, "Could not verify the selected image file.")
		}
		if os.SameFile(source, info) {
			return appErr("invalidSourcePath", "The selected file is part of Pic Piper’s private data. Choose another image.")
		}
		return nil
	}
	if err := check(s.settingsPath()); err != nil {
		return err
	}
	credentials := filepath.Join(s.dataDir, "credentials")
	entries, err := os.ReadDir(credentials)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return appErr(readErrorCode, "Could not verify the selected image file.")
	}
	for _, entry := range entries {
		if err := check(filepath.Join(credentials, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) resolveDownloadDir(path string) (string, error) {
	dir, err := canonicalPath(s.dataDir)
	if err != nil {
		return "", appErr("invalidDownloadPath", "Could not verify the download destination. Choose another folder.")
	}
	destination, err := canonicalPath(path)
	if err != nil || pathWithin(destination, dir) {
		return "", appErr("invalidDownloadPath", "Choose a download folder outside Pic Piper’s private data folder.")
	}
	return destination, nil
}

func (s *Service) readUploadSource(ctx context.Context, path, readErrorCode string) (*os.File, int64, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, "", err
	}
	resolved, err := s.resolveUploadPath(path, readErrorCode)
	if err != nil {
		return nil, 0, "", err
	}
	before, err := os.Stat(resolved)
	if err != nil || !before.Mode().IsRegular() {
		return nil, 0, "", appErr(readErrorCode, "Choose a regular image file.")
	}
	if before.Size() <= 0 || before.Size() > maxS3UploadBytes {
		return nil, 0, "", appErr(readErrorCode, "Choose a nonempty image file no larger than 5 GiB.")
	}
	file, err := openUploadFile(resolved)
	if err != nil {
		return nil, 0, "", appErr(readErrorCode, "Could not open the selected image file.")
	}
	keep := false
	defer func() {
		if !keep {
			_ = file.Close()
		}
	}()

	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) || opened.Size() != before.Size() {
		return nil, 0, "", appErr(readErrorCode, "The selected image file changed. Select it again.")
	}
	checked, err := s.resolveUploadPath(resolved, readErrorCode)
	if err != nil {
		return nil, 0, "", err
	}
	current, err := os.Stat(checked)
	if err != nil || !os.SameFile(opened, current) {
		return nil, 0, "", appErr(readErrorCode, "The selected image file changed. Select it again.")
	}
	if err := s.checkUploadSourceIdentity(opened, readErrorCode); err != nil {
		return nil, 0, "", err
	}

	size := opened.Size()
	hash := sha256.New()
	read, err := io.Copy(hash, io.LimitReader(uploadContextReader{ctx, file}, size+1))
	if cause := requestContextError(err); cause != nil {
		return nil, 0, "", cause
	}
	if err != nil || read != size {
		return nil, 0, "", appErr(readErrorCode, "Could not read the complete image. Check that the file has not changed.")
	}
	after, err := file.Stat()
	if err != nil || after.Size() != size || !after.ModTime().Equal(opened.ModTime()) {
		return nil, 0, "", appErr(readErrorCode, "The selected image file changed. Select it again.")
	}
	if err := ctx.Err(); err != nil {
		return nil, 0, "", err
	}
	keep = true
	return file, size, hex.EncodeToString(hash.Sum(nil)), nil
}

type uploadContextReader struct {
	ctx context.Context
	io.Reader
}

func (r uploadContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.Reader.Read(p)
	if cause := r.ctx.Err(); cause != nil {
		return n, cause
	}
	return n, err
}
