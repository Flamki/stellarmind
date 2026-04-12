from PIL import Image
import cv2
import numpy as np

input_path = r"C:\Users\bbook\.gemini\antigravity\brain\5490372b-b9a8-4ed5-9246-dc7f6c164b64\stellarmind_fixed_x402_1776010909176.webp"
output_path = r"C:\Users\bbook\Desktop\stellar\stellarmind_fixed_demo.mp4"

print("Opening WebP...")
img = Image.open(input_path)

frames = []
durations = []

try:
    while True:
        # Convert frame to numpy array
        # Background is black/dark blue for the UI, so RGBA to RGB is fine
        frame = img.copy().convert("RGB")
        img_np = np.array(frame)
        
        # OpenCV uses BGR instead of RGB
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
        frames.append(img_bgr)
        durations.append(img.info.get('duration', 100))
        img.seek(img.tell() + 1)
except EOFError:
    pass

print(f"Extracted {len(frames)} frames. Generating video...")

if frames:
    height, width, layers = frames[0].shape
    # Calculate average FPS
    avg_duration_ms = sum(durations) / len(durations)
    fps = 1000.0 / avg_duration_ms
    print(f"Calculated FPS: {fps:.2f}")

    # Initialize video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v') # type: ignore
    video = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    for idx, frame in enumerate(frames):
        video.write(frame)
        if idx % 50 == 0:
            print(f"Written {idx}/{len(frames)} frames...")

    cv2.destroyAllWindows()
    video.release()
    print(f"Success! Video saved to {output_path}")
else:
    print("Failed to extract frames.")
