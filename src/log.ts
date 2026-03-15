let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

/** Print a section header */
export function header(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

/** Print a normal info line (indented) */
export function info(msg: string): void {
  console.log(`  ${msg}`);
}

/** Print only in verbose mode (indented) */
export function debug(msg: string): void {
  if (_verbose) console.log(`  ${msg}`);
}

/** Strip XML-like tags from step descriptions for cleaner output */
export function cleanDescription(desc: string): string {
  return desc.replace(/<(\w+)>(.*?)<\/\1>/g, '"$2"');
}
