export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

export class EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventError';
  }
}

export class WakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakeError';
  }
}
