document.documentElement.dataset.theme=localStorage.getItem('sp-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
