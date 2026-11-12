package imaging

import (
	"context"
	"io"
	"os"
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.reader.Read(buffer)
	if err == nil {
		err = r.ctx.Err()
	}
	return n, err
}

func copyReserved(ctx context.Context, dir, name string, source io.Reader) (string, error) {
	output, err := reserve(dir, name)
	if err != nil {
		return "", err
	}
	complete := false
	defer func() {
		output.Close()
		if !complete {
			_ = os.Remove(output.Name())
		}
	}()
	if _, err := io.Copy(output, contextReader{ctx: ctx, reader: source}); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := output.Close(); err != nil {
		return "", err
	}
	complete = true
	return output.Name(), nil
}
