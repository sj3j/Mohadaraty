export type DoctorListResult<Doctor> = {
  doctors: Doctor[];
  truncated: boolean;
};

export function createLatestDoctorListRefresher<Doctor>(
  request: () => Promise<DoctorListResult<Doctor>>,
  apply: (result: DoctorListResult<Doctor>) => void,
) {
  let latestRequest = 0;

  return async () => {
    const requestNumber = ++latestRequest;
    let result: DoctorListResult<Doctor>;
    try {
      result = await request();
    } catch (error) {
      // An obsolete failure must not overwrite a newer creation/refresh message.
      if (requestNumber !== latestRequest) return { doctors: [], truncated: false, applied: false };
      throw error;
    }
    const applied = requestNumber === latestRequest;
    if (applied) apply(result);
    return { ...result, applied };
  };
}
