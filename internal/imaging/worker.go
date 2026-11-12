package imaging

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type workerReply struct {
	Data  json.RawMessage `json:"data"`
	Error *apperror.Error `json:"error,omitempty"`
}

// NewIsolated runs image work in this application's own executable. Cancelling
// its context terminates the codec process, including synchronous WASM calls.
func NewIsolated(dataDir string) *Service {
	service := New(dataDir)
	service.executable, service.executableErr = os.Executable()
	return service
}

// RunWorker handles the private child-process protocol before any GUI starts.
func RunWorker() bool {
	if len(os.Args) < 2 || os.Args[1] != "--image-worker" {
		return false
	}
	response := workerReply{}
	if len(os.Args) != 4 || !workerOperation(os.Args[3]) {
		response.Error = apperror.New("invalidRequest", "The image worker request is invalid.")
	} else {
		payload, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
		if err == nil {
			var value any
			value, err = New(os.Args[2]).Call(context.Background(), os.Args[3], payload)
			if err == nil {
				response.Data, err = json.Marshal(value)
			}
		}
		if err != nil {
			if !errors.As(err, &response.Error) {
				response.Error = apperror.New("imageProcessingFailed", "Could not process this image. Try another format or check available memory and disk space.")
			}
		}
	}
	_ = json.NewEncoder(os.Stdout).Encode(response)
	return true
}

func workerOperation(operation string) bool {
	switch operation {
	case "inspect_image", "compress_image", "read_thumbnail", "read_comparison_image":
		return true
	}
	return false
}

func (s *Service) isolated(ctx context.Context, operation string, req request) (any, error) {
	if s.executableErr != nil {
		return nil, s.executableErr
	}
	var stage string
	complete := false
	if operation == "compress_image" {
		dir, err := under(s.cacheDir, req.OutputDir)
		if err != nil {
			return nil, err
		}
		stage, err = os.MkdirTemp(dir, "job-")
		if err != nil {
			return nil, err
		}
		defer func() {
			if !complete {
				_ = os.RemoveAll(stage)
			}
		}()
		req.OutputDir = stage
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, s.executable, "--image-worker", s.dataDir, operation)
	command.Stdin = strings.NewReader(string(payload))
	output, err := command.Output()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, apperror.New("imageProcessingFailed", "The image worker stopped. Retry the image or choose a smaller input.")
	}
	var response workerReply
	if err := json.Unmarshal(output, &response); err != nil {
		return nil, apperror.New("imageProcessingFailed", "The image worker returned an unreadable result.")
	}
	if response.Error != nil {
		return nil, response.Error
	}
	var value any
	if err := json.Unmarshal(response.Data, &value); err != nil {
		return nil, err
	}
	complete = true
	return value, nil
}
