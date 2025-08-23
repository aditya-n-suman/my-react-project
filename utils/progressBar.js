const progressBar = {
  total: 0,
  current: 0,
  bar_length: 30,
  
  init(total) {
    this.total = total;
    this.current = 0;
    this.update(0);
  },
  
  update(current) {
    this.current = current;
    const percentage = this.current / this.total;
    const filled_length = Math.round(this.bar_length * percentage);
    const empty_length = this.bar_length - filled_length;
    
    const filled = "█".repeat(filled_length);
    const empty = "░".repeat(empty_length);
    const percent = Math.round(percentage * 100);
    
    process.stdout.write(`\r${filled}${empty} ${percent}% | ${this.current}/${this.total}`);
    
    if (this.current === this.total) {
      process.stdout.write('\n');
    }
  },
  
  increment() {
    this.update(this.current + 1);
  }
};

export { progressBar };
