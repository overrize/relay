import {useEffect,useState} from "react";
import {getState,subscribe} from "../store.js";
type State=ReturnType<typeof getState>;
export function useStore<T>(sel: (s: State) => T): T {
  const [val, setVal] = useState<T>(() => sel(getState()));
  useEffect(() => subscribe(() => setVal(sel(getState()))), []);
  return val;
}
