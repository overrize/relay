/** Shell-free tokenization; quoted Windows paths retain their backslashes. */
export function splitCommand(text:string){
  const tokens:string[]=[];let word='',quote='';
  for(const c of text){if(quote){if(c===quote)quote='';else word+=c;}else if(c==='"'||c==="'")quote=c;else if(/\s/.test(c)){if(word){tokens.push(word);word='';}}else word+=c;}
  if(quote)return [];if(word)tokens.push(word);return tokens;
}
