I have a T1-weighted MRI as a DICOM series in {{dicom_dir}}
and a skull-stripped MNI152 template at {{template}}.

Using only the NeuroFlow tools, build one workflow that:
1. converts the DICOM series to NIfTI,
2. skull-strips it,
3. registers the stripped brain to the MNI template with an affine transform,
4. segments the brain into anatomical structures, and
5. measures the volume of every structure in mL.

Compose the workflow yourself from the registered tools (do not run the
pre-built gallery workflows), validate it, run it on my data, and then report:
the left and right hippocampus volumes, the total brain-mask volume, the cost
function used for the registration, and the artifact URI of the brain in MNI
space. Keep the workflow document you ran in your answer as a JSON code block.
