export class ComposioServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ComposioServiceError';
    this.status = status;
  }
}
