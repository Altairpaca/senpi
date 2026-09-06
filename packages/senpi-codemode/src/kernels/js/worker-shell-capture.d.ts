export type ShellCaptureStream = "stdout" | "stderr";

export type ShellCaptureRestore = () => void;

export interface ShellCaptureChild {
	readonly exitCode: number | null;
	readonly signalCode: string | null;
	readonly exited: Promise<number>;
	kill(): void;
}

export interface ShellCaptureOptions {
	readonly isActive: () => boolean;
	readonly emitText: (stream: ShellCaptureStream, data: string) => void;
	/** Receives every `Bun.spawn` child created while a cell is active so the runtime can kill it on interrupt. */
	readonly onChild?: (child: ShellCaptureChild) => void;
}

export function installShellCapture(options: ShellCaptureOptions): ShellCaptureRestore;
