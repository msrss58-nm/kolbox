import { forwardRef, type InputHTMLAttributes } from "react";
import { he } from "date-fns/locale";
import DatePicker, { registerLocale } from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { cn } from "../../lib/utils";
import { fieldClasses } from "./Field";

registerLocale("he", he);

/** react-datepicker clones this element and injects value/onClick/onChange -
 * a forwarded ref lets it manage focus/positioning correctly. Reuses the
 * shared `fieldClasses` so it looks identical to every other text input. */
const DateTimePickerInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    readOnly
    dir="ltr"
    className={cn(fieldClasses, "cursor-pointer text-end", className)}
    {...props}
  />
));
DateTimePickerInput.displayName = "DateTimePickerInput";

/** A styled date+time picker (react-datepicker under the hood, themed to
 * match the app's cards/dropdowns via the `.kb-datepicker*` rules in
 * index.css) - replaces the native `<input type="datetime-local">`, whose
 * browser-default popup couldn't be styled at all. */
export function DateTimePicker({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: Date | null;
  onChange: (date: Date | null) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <DatePicker
      selected={value}
      onChange={onChange}
      showTimeSelect
      timeFormat="HH:mm"
      timeIntervals={15}
      timeCaption="שעה"
      dateFormat="dd/MM/yyyy HH:mm"
      locale="he"
      placeholderText={placeholder}
      shouldCloseOnSelect={false}
      customInput={<DateTimePickerInput className={className} />}
      calendarClassName="kb-datepicker"
      popperClassName="kb-datepicker-popper"
      popperPlacement="bottom-end"
    />
  );
}
