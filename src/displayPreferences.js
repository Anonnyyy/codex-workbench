import {useState} from 'react';

export const displayCounts=[1,3,5,10,20,50,100,0];
export function validDisplayCount(value,fallback=3){const n=Number(value);return Number.isInteger(n)&&n>=0&&n<=1000?n:fallback;}
export function useDisplayPreference(key,initial){
  const [value,setValue]=useState(()=>{try{return JSON.parse(localStorage.getItem(key))??initial;}catch{return initial;}});
  function save(next){setValue(old=>{const result=typeof next==='function'?next(old):next;try{localStorage.setItem(key,JSON.stringify(result));}catch{}return result;});}
  return [value,save];
}
