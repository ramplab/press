export interface Greeting {
  message: string;
}

export function greet(name: string): Greeting {
  return { message: `Hello, ${name}!` };
}

export function shout(name: string): string {
  return greet(name).message.toUpperCase();
}
