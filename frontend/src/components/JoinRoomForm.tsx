import { FormEvent, useState } from "react";

type JoinRoomFormProps = {
  mode: "create" | "join" | "username";
  roomCode?: string;
  onSubmit: (username: string) => Promise<void>;
};

export function JoinRoomForm({ mode, roomCode, onSubmit }: JoinRoomFormProps) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(username);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to continue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="entry">
      <section className="entry-panel">
        <p className="eyebrow">MiniRTC</p>
        <h1>{mode === "create" ? "Create a room" : mode === "join" ? "Join room" : "Enter your name"}</h1>
        {roomCode ? <p className="subtle">Room {roomCode}</p> : null}
        <form onSubmit={handleSubmit} className="form-stack">
          <label>
            Display name
            <input
              value={username}
              maxLength={40}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Your name"
              autoFocus
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" disabled={isSubmitting || !username.trim()}>
            {isSubmitting
              ? "Working..."
              : mode === "create"
                ? "Create Room"
                : mode === "join"
                  ? "Join Room"
                  : "Continue"}
          </button>
        </form>
      </section>
    </main>
  );
}
