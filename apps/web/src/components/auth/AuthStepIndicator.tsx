import { Check } from '@/components/ui/icons';
type AuthStepIndicatorProps = { steps: Array<{ id: string; label: string }>; current: string };
export function AuthStepIndicator({ steps, current }: AuthStepIndicatorProps) {
  const currentIndex = Math.max(0, steps.findIndex(step => step.id === current));
  return <ol className="auth-stepper" aria-label="Account setup progress">{steps.map((step,index) => <li className="auth-step" key={step.id} aria-current={step.id === current ? 'step' : undefined}><span>{index < currentIndex ? <Check size={12} /> : index + 1}</span>{step.label}</li>)}</ol>;
}
export default AuthStepIndicator;
