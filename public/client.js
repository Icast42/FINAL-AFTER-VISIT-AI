let pc = null;          // RTCPeerConnection
let dc = null;          // DataChannel for Realtime events
let micStream = null;   // Microphone MediaStream
let audioEl = null;     // Audio element for assistant voice

const debugEl  = document.getElementById("debug");
const avatarEl = document.getElementById("avatar");
const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");

avatarEl.src = "avatar.mp4";

let currentText = "";   // buffer for response.output_text.delta chunks

function log(msg) {
  const t = new Date().toLocaleTimeString();
  debugEl.innerHTML += `[${t}] ${msg}<br>`;
  debugEl.scrollTop = debugEl.scrollHeight;
}

async function startAI() {
  try {
    if (pc) {
      log("Already running.");
      return;
    }

    log("Requesting ephemeral session token from /session...");

    const sessionRes = await fetch("/session", { method: "POST" });
    const data = await sessionRes.json();

    // GA client_secret response: { ... , value: "ek_..." }
    if (!data.value) {
      log("Session error (no client_secret value): " + JSON.stringify(data));
      return;
    }

    const EPHEMERAL_KEY = data.value;
    log("Session OK. Got ephemeral key.");

    // ----- Create RTCPeerConnection -----
    pc = new RTCPeerConnection();

    // Remote audio from the model
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.muted = false;
    audioEl.volume = 1.0;
    audioEl.controls = true;
    audioEl.style.position = "fixed";
    audioEl.style.left = "10px";
    audioEl.style.bottom = "10px";
    audioEl.style.zIndex = "9999";
    document.body.appendChild(audioEl);

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      audioEl.srcObject = stream;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const track = audioTracks[0];
        log("Remote track kind=" + track.kind);
        track.onunmute = () => log("Remote audio track UNMUTED (audio frames flowing).");
        track.onmute = () => log("Remote audio track MUTED.");
      } else {
        log("Remote stream has no audio tracks?");
      }

      log("Remote audio track attached.");
      const p = audioEl.play();
      if (p !== undefined) {
        p.then(() => {
          log("Audio playback started.");
        }).catch(err => {
          log("audio.play error: " + err.message);
        });
      }
    };

    // Data channel for Realtime events
    dc = pc.createDataChannel("oai-events");

    dc.onopen = () => {
      log("Data channel open.");
      // For GA, our session config (model, audio.voice, instructions) is set
      // when we requested the client_secret, so we don't have to send a big
      // session.update here. We can add tweaks later if needed.
    };

    dc.onmessage = (e) => {
      try {
        const obj = JSON.parse(e.data);

        switch (obj.type) {
          case "error":
            log("ERROR EVENT: " + JSON.stringify(obj));
            break;

          case "input_audio_buffer.speech_started":
          case "input_audio_buffer.speech_stopped":
          case "input_audio_buffer.committed":
          case "conversation.item.added":
          case "conversation.item.created":
          case "conversation.item.done":
          case "response.created":
          case "response.output_item.added":
          case "response.output_item.done":
          case "response.done":
          case "rate_limits.updated":
          case "conversation.item.input_audio_transcription.delta":
          case "conversation.item.input_audio_transcription.completed":
            log("EVT: " + obj.type);
            break;

          // GA name: response.output_text.delta
          case "response.output_text.delta":
            if (typeof obj.delta === "string") {
              currentText += obj.delta;
            } else if (obj.delta && typeof obj.delta.text === "string") {
              currentText += obj.delta.text;
            }
            break;

          // GA name: response.output_text.done
          case "response.output_text.done": {
            let finalText = currentText;
            if ((!finalText || !finalText.trim()) && typeof obj.text === "string") {
              finalText = obj.text;
            }

            if (finalText && finalText.trim().length > 0) {
              log("AI says: " + finalText.trim());
            } else {
              log("AI finished a response with no text?");
            }
            currentText = "";
            break;
          }

          // GA name: response.output_audio_transcript.done (what she actually spoke)
          case "response.output_audio_transcript.done":
            log("AI (audio transcript): " + (obj.transcript || ""));
            break;

          default:
            log("EVT: " + obj.type);
            break;
        }
      } catch {
        log("EVT RAW: " + e.data);
      }
    };

    dc.onerror = (e) => {
      log("Data channel error: " + e.message);
    };

    // ----- Attach microphone -----
    log("Requesting microphone...");
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream.getTracks().forEach((track) => {
      pc.addTrack(track, micStream);
    });
    log("Microphone attached.");

    // ----- WebRTC SDP handshake with GA Realtime /v1/realtime/calls -----
    log("Creating local SDP offer...");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime/calls";

    log("Sending SDP offer to OpenAI Realtime (GA calls endpoint)...");
    const sdpRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + EPHEMERAL_KEY,
        "Content-Type": "application/sdp"
      },
      body: offer.sdp
    });

    if (!sdpRes.ok) {
      const txt = await sdpRes.text();
      log("SDP error " + sdpRes.status + ": " + txt);
      return;
    }

    const answerSdp = await sdpRes.text();
    const answer = { type: "answer", sdp: answerSdp };
    await pc.setRemoteDescription(answer);

    log("DripBar AI connected via GA Realtime WebRTC. Listening for your voice...");
  } catch (err) {
    console.error(err);
    log("START error: " + (err.message || err.toString()));
  }
}

function stopAI() {
  try {
    if (dc) {
      try { dc.close(); } catch {}
      dc = null;
    }

    if (pc) {
      try { pc.close(); } catch {}
      pc = null;
    }

    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    if (audioEl) {
      audioEl.srcObject = null;
      try { audioEl.remove(); } catch {}
      audioEl = null;
    }

    currentText = "";

    log("Stopped DripBar AI.");
  } catch (err) {
    log("STOP error: " + (err.message || err.toString()));
  }
}

startBtn.onclick = startAI;
stopBtn.onclick  = stopAI;
