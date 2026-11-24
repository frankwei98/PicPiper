package cloud

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

type deleteGalleryRequest struct {
	Profile  profile `json:"profile"`
	Key      string  `json:"key"`
	UploadID string  `json:"uploadId"`
	ETag     string  `json:"etag"`
}

func (s *Service) deleteGalleryObject(ctx context.Context, request deleteGalleryRequest) error {
	if err := validateKey(request.Key); err != nil {
		return err
	}
	if request.UploadID == "" {
		return appErr("s3ObjectUnverified", "Refresh the gallery before deleting this image.")
	}
	secret, err := s.getSecret(request.Profile, nil)
	if err != nil {
		return err
	}
	id, etag, err := s.headUpload(ctx, request.Profile, secret, request.Key)
	if err == nil {
		if id != request.UploadID || (request.ETag != "" && request.ETag != etag) {
			return appErr("s3ObjectChanged", "This image changed. Refresh the gallery before deleting it.")
		}
		// If-Match must contain exactly one strong entity tag.
		if len(etag) < 2 || etag[0] != '"' || etag[len(etag)-1] != '"' || strings.ContainsAny(etag[1:len(etag)-1], "\" ") || hasControl(etag) {
			return appErr("s3ObjectUnverified", "The provider did not return a usable ETag for this image.")
		}
		var response *http.Response
		response, err = s.doS3(ctx, request.Profile, secret, http.MethodDelete, request.Key, nil, "", http.Header{"If-Match": {etag}})
		if err == nil {
			response.Body.Close()
		}
	}
	if err != nil {
		var status *statusError
		if !errors.As(err, &status) {
			return s3error("s3DeleteFailed", err)
		}
		switch status.status {
		case http.StatusNotFound:
			// Another client already removed the selected image.
		case http.StatusPreconditionFailed, http.StatusConflict:
			return appErr("s3ObjectChanged", "This image changed. Refresh the gallery before deleting it.")
		default:
			return s3error("s3DeleteFailed", err)
		}
	}
	s.removeGalleryThumbnails(ctx, request.Profile, request.Key)
	s.mu.Lock()
	records, historyErr := s.loadUploadRecordsLocked(request.Profile)
	observed := records[request.Key]
	s.mu.Unlock()
	if historyErr == nil && observed.UploadID == request.UploadID {
		_ = s.forgetInvalidUploads(request.Profile, []uploadedImage{observed})
	}
	return nil
}
