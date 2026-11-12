import { describe, expect, it } from "vitest";
import { errorCode, errorMessage } from "./error";

describe("structured backend error helpers", () => {
  it("reads the message and code from a serialized backend error", () => {
    const error = {
      code: "objectAlreadyExists",
      message: "An object with this key already exists.",
      recoverable: true,
    };

    expect(errorCode(error)).toBe("objectAlreadyExists");
    expect(errorMessage(error, "Upload failed")).toBe("An object with this key already exists.");
  });

  it("uses an Error message and falls back for unknown rejections", () => {
    expect(errorMessage(new Error("Network timeout"), "Upload failed")).toBe("Network timeout");
    expect(errorMessage({ code: "unexpected" }, "Upload failed")).toBe("Upload failed");
  });
});
