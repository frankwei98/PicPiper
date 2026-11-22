package imaging

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"

	"github.com/frankwei98/PicPiper/internal/apperror"
)

type workerReply struct {
	Data  json.RawMessage `json:"data"`
	Error *apperror.Error `json:"error,omitempty"`
}

type workerRequest struct {
	Operation string          `json:"operation"`
	Payload   json.RawMessage `json:"payload"`
}

// Each process handles one request at a time, keeping compiled WASM codecs warm.
// The service's image budget bounds busy and cached processes.
type imageWorker struct {
	command *exec.Cmd
	input   io.WriteCloser
	output  io.ReadCloser
}

// NewIsolated runs image work in this application's own executable. Cancelling
// its context terminates the codec process, including synchronous WASM calls.
func NewIsolated(dataDir string) *Service {
	service := New(dataDir)
	service.executable, service.executableErr = os.Executable()
	service.previews.removeAbandoned()
	return service
}

// RunWorker handles the private child-process protocol before any GUI starts.
func RunWorker() bool {
	if len(os.Args) < 2 || os.Args[1] != "--image-worker" {
		return false
	}
	if len(os.Args) != 3 {
		_ = json.NewEncoder(os.Stdout).Encode(workerReply{Error: apperror.New("invalidRequest", "The image worker request is invalid.")})
		return true
	}
	service := New(os.Args[2])
	defer service.Close()
	serveWorker(os.Stdin, os.Stdout, service.Call)
	return true
}

func serveWorker(input io.Reader, output io.Writer, call func(context.Context, string, json.RawMessage) (any, error)) {
	requests := bufio.NewScanner(input)
	requests.Buffer(make([]byte, 4096), 1<<20)
	responses := json.NewEncoder(output)
	for requests.Scan() {
		var req workerRequest
		var value any
		response := workerReply{}
		err := json.Unmarshal(requests.Bytes(), &req)
		if err != nil || !workerOperation(req.Operation) || req.Operation == "copy_image_png" {
			err = apperror.New("invalidRequest", "The image worker request is invalid.")
		} else {
			value, err = call(context.Background(), req.Operation, req.Payload)
		}
		if err == nil {
			response.Data, err = json.Marshal(value)
		}
		if err != nil && !errors.As(err, &response.Error) {
			response.Error = apperror.New("imageProcessingFailed", "Could not process this image. Try another format or check available memory and disk space.")
		}
		if err := responses.Encode(response); err != nil {
			return
		}
	}
}

func workerOperation(operation string) bool {
	switch operation {
	case "inspect_image", "compress_image", "read_thumbnail", "read_comparison_image", "render_preview_png", "copy_image_png":
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
	worker, err := s.takeWorker()
	if err != nil {
		return nil, apperror.New("imageProcessingFailed", "The image worker stopped. Retry the image or choose a smaller input.")
	}
	response, err := worker.call(ctx, workerRequest{Operation: operation, Payload: payload})
	if err != nil {
		worker.close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, apperror.New("imageProcessingFailed", "The image worker stopped. Retry the image or choose a smaller input.")
	}
	s.workerMu.Lock()
	s.idleWorkers = append(s.idleWorkers, worker)
	s.workerMu.Unlock()
	s.trimIdleWorkers()
	if response.Error != nil {
		return nil, response.Error
	}
	if operation == "render_preview_png" {
		var preview ComparisonImage
		err := json.Unmarshal(response.Data, &preview)
		return preview, err
	}
	var value any
	if err := json.Unmarshal(response.Data, &value); err != nil {
		return nil, err
	}
	complete = true
	return value, nil
}

func (s *Service) takeWorker() (*imageWorker, error) {
	s.workerMu.Lock()
	if last := len(s.idleWorkers) - 1; last >= 0 {
		worker := s.idleWorkers[last]
		s.idleWorkers = s.idleWorkers[:last]
		s.workerMu.Unlock()
		return worker, nil
	}
	s.workerMu.Unlock()
	command := exec.Command(s.executable, "--image-worker", s.dataDir)
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	if err := command.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		return nil, err
	}
	return &imageWorker{command: command, input: input, output: output}, nil
}

func (worker *imageWorker) call(ctx context.Context, req workerRequest) (workerReply, error) {
	type result struct {
		response workerReply
		err      error
	}
	finished := make(chan result, 1)
	go func() {
		var response workerReply
		err := json.NewEncoder(worker.input).Encode(req)
		if err == nil {
			// A decoder is scoped to one response so a large comparison doesn't
			// retain its JSON buffer for the lifetime of an idle process.
			err = json.NewDecoder(worker.output).Decode(&response)
		}
		finished <- result{response: response, err: err}
	}()
	select {
	case result := <-finished:
		if err := ctx.Err(); err != nil {
			return workerReply{}, err
		}
		return result.response, result.err
	case <-ctx.Done():
		// Close the pipes to unblock both a large request write and a codec
		// response read before the caller reaps the synchronous process.
		_ = worker.input.Close()
		_ = worker.output.Close()
		<-finished
		return workerReply{}, ctx.Err()
	}
}

func (worker *imageWorker) close() {
	_ = worker.command.Process.Kill()
	_ = worker.input.Close()
	_ = worker.output.Close()
	_ = worker.command.Wait()
}

func (s *Service) closeIdleWorkers() {
	s.workerMu.Lock()
	workers := s.idleWorkers
	s.idleWorkers = nil
	s.workerMu.Unlock()
	for _, worker := range workers {
		worker.close()
	}
}
